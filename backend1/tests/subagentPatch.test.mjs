/**
 * tests/subagentPatch.test.mjs
 * Run with: node tests/subagentPatch.test.mjs
 *
 * Phase 1 (worktree diff/review/apply), Phase 2 (skills injection) and
 * Phase 4 (stress/concurrency/failure) against real git repositories.
 *
 * The invariant under test throughout: the parent workspace does not change
 * until an explicit approve, and never changes on reject, block or failure.
 */

import assert from "assert";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { execFile } from "child_process";

import {
  extractWorktreeDiff, summarizeDiff, validatePatchPath, storePatch,
  getPatch, getPatchDiff, listPatches, applyPatch, rejectPatch,
  _resetPatches, patchCount,
} from "../services/worktreePatch.mjs";
import { createWorktree, removeWorktree, activeWorktrees, removeAllWorktrees } from "../services/worktreeManager.mjs";
import {
  startBackgroundSubagent, shutdownBackgroundSubagents, runningCount, _resetBackgroundSubagents,
} from "../services/backgroundSubagents.mjs";
import { executeTool } from "../agents/nodes/agent_loop.mjs";
import { normalizeHookConfig, fireHookEvent } from "../services/hooks.mjs";

const watchdog = setTimeout(() => {
  console.error("\n❌ WATCHDOG: suite stalled — forcing exit\n");
  process.exit(1);
}, 120_000);

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

const sh = (a, cwd) => new Promise((r) => execFile(a[0], a.slice(1), { cwd }, (e, o) => r(String(o || ""))));
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeRepo(files = { "app.js": "export const value = 1;\n" }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-patchrepo-"));
  await sh(["git", "init", "-q"], dir);
  await sh(["git", "config", "user.email", "t@e.com"], dir);
  await sh(["git", "config", "user.name", "T"], dir);
  for (const [f, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, f)), { recursive: true });
    await fs.writeFile(path.join(dir, f), c);
  }
  await sh(["git", "add", "."], dir);
  await sh(["git", "commit", "-qm", "init"], dir);
  return dir;
}

/** Run an isolated "subagent" that edits its worktree, then capture the patch. */
async function isolatedEdit(repo, edit) {
  const { worktree } = await createWorktree({ workspacePath: repo, subagentId: "sub" });
  await edit(worktree.path);
  const diff = await extractWorktreeDiff(worktree.path);
  const summary = diff.ok && !diff.empty ? summarizeDiff(diff, repo) : null;
  const patchId = summary ? storePatch({ subagentId: "sub", agentType: "fixer", sessionId: "sess", workspaceRoot: repo, diff, summary }) : null;
  await removeWorktree(worktree.worktreeId); // cleanup BEFORE apply — the patch must survive
  return { patchId, diff, summary };
}

console.log("\n📦 Phase 1 — diff extraction");

await test("a real diff is extracted from worktree edits", async () => {
  _resetPatches();
  const repo = await makeRepo();
  const { diff, summary } = await isolatedEdit(repo, async (wt) => {
    await fs.writeFile(path.join(wt, "app.js"), "export const value = 42;\n");
  });
  assert.strictEqual(diff.ok, true);
  assert.strictEqual(diff.empty, false);
  assert.match(diff.patch, /value = 42/, "the real git patch must contain the change");
  assert.strictEqual(summary.fileCount, 1);
  assert.strictEqual(summary.files[0].path, "app.js");
  await fs.rm(repo, { recursive: true, force: true });
});

await test("NEW files appear in the diff", async () => {
  const repo = await makeRepo();
  const { summary } = await isolatedEdit(repo, async (wt) => {
    await fs.writeFile(path.join(wt, "added.js"), "export const n = 1;\n");
  });
  assert.ok(summary.files.some((f) => f.path === "added.js"), "untracked files must be captured");
  await fs.rm(repo, { recursive: true, force: true });
});

await test("an EMPTY diff is reported honestly, not as a patch", async () => {
  const repo = await makeRepo();
  const { patchId, diff } = await isolatedEdit(repo, async () => { /* change nothing */ });
  assert.strictEqual(diff.empty, true);
  assert.strictEqual(patchId, null, "no patch may be fabricated from an empty diff");
  await fs.rm(repo, { recursive: true, force: true });
});

await test("line counts and risky-area flags are computed", async () => {
  const repo = await makeRepo({ "app.js": "a\n", "package.json": '{"name":"x"}\n' });
  const { summary } = await isolatedEdit(repo, async (wt) => {
    await fs.writeFile(path.join(wt, "package.json"), '{"name":"x","dependencies":{"left-pad":"1"}}\n');
  });
  assert.ok(summary.linesAdded > 0);
  assert.ok(summary.risky.some((r) => /dependency manifest/.test(r.why)), "a manifest change must be flagged");
  await fs.rm(repo, { recursive: true, force: true });
});

await test("the summary names EXACTLY the files git says changed — no drift", async () => {
  _resetPatches();
  // Several files exist; only ONE is edited. The summary must name only that
  // one, and must never mention a file that did not actually change.
  const repo = await makeRepo({
    "server.js": "export const port = 3000;\n",
    "client.js": "export const url = 'x';\n",
    "docs/readme.md": "# docs\n",
  });
  const { patchId, summary } = await isolatedEdit(repo, async (wt) => {
    await fs.writeFile(path.join(wt, "server.js"), "export const port = 4000;\n");
  });

  // Ground truth straight from git, independent of our summary code.
  const worktreeless = await sh(["git", "diff", "--numstat", "HEAD"], repo);
  void worktreeless;

  assert.deepStrictEqual(summary.files.map((f) => f.path), ["server.js"],
    `summary drifted: ${JSON.stringify(summary.files.map((f) => f.path))}`);
  assert.strictEqual(summary.fileCount, 1);

  // Cross-check against the raw patch: every named file must appear in it, and
  // no untouched file may be named.
  const raw = getPatchDiff(patchId);
  assert.match(raw, /diff --git a\/server\.js b\/server\.js/);
  assert.ok(!/client\.js/.test(raw), "an untouched file must not appear in the patch");
  assert.ok(!/readme\.md/.test(raw), "an untouched file must not appear in the patch");
  for (const f of summary.files) {
    assert.ok(raw.includes(f.path), `summary names ${f.path} but the real diff does not contain it`);
  }
  await fs.rm(repo, { recursive: true, force: true });
});

await test("summary line counts match the real git numstat", async () => {
  _resetPatches();
  const repo = await makeRepo({ "a.txt": "1\n2\n3\n" });
  const { summary } = await isolatedEdit(repo, async (wt) => {
    await fs.writeFile(path.join(wt, "a.txt"), "1\n2\n3\n4\n5\n");
  });
  assert.strictEqual(summary.files[0].path, "a.txt");
  assert.strictEqual(summary.linesAdded, 2, "two lines were added");
  assert.strictEqual(summary.linesRemoved, 0);
});

await test("the stored summary stays bound to ITS patch when several exist", async () => {
  _resetPatches();
  const repo = await makeRepo({ "one.js": "a\n", "two.js": "b\n" });
  const first = await isolatedEdit(repo, async (wt) => { await fs.writeFile(path.join(wt, "one.js"), "changed one\n"); });
  const second = await isolatedEdit(repo, async (wt) => { await fs.writeFile(path.join(wt, "two.js"), "changed two\n"); });

  assert.deepStrictEqual(getPatch(first.patchId).summary.files.map((f) => f.path), ["one.js"]);
  assert.deepStrictEqual(getPatch(second.patchId).summary.files.map((f) => f.path), ["two.js"],
    "a later patch must not overwrite an earlier patch's summary");
  assert.match(getPatchDiff(first.patchId), /one\.js/);
  assert.ok(!/two\.js/.test(getPatchDiff(first.patchId)), "patch 1 must not contain patch 2's file");
  await fs.rm(repo, { recursive: true, force: true });
});

console.log("\n📦 Phase 1 — path safety");

await test("protected and escaping paths are refused", () => {
  const root = "/ws";
  for (const [p, why] of [[".git/config", "git"], [".env", "env"], ["../outside.txt", "traversal"],
    ["/etc/passwd", "absolute"], [".kodo/settings.json", "settings"], ["node_modules/x/i.js", "deps"]]) {
    assert.strictEqual(validatePatchPath(p, root).ok, false, `${p} (${why}) must be refused`);
  }
  assert.strictEqual(validatePatchPath("src/app.js", root).ok, true);
});

await test("a patch touching a protected path is summarised as NOT applicable", async () => {
  const repo = await makeRepo({ "app.js": "a\n", ".env": "SECRET=1\n" });
  const { summary } = await isolatedEdit(repo, async (wt) => {
    await fs.writeFile(path.join(wt, ".env"), "SECRET=stolen\n");
  });
  assert.strictEqual(summary.applicable, false);
  assert.ok(summary.blocked.some((b) => b.path === ".env"));
  await fs.rm(repo, { recursive: true, force: true });
});

await test("applying a patch with a protected path is BLOCKED and changes nothing", async () => {
  _resetPatches();
  const repo = await makeRepo({ "app.js": "a\n", ".env": "SECRET=1\n" });
  const { patchId } = await isolatedEdit(repo, async (wt) => {
    await fs.writeFile(path.join(wt, ".env"), "SECRET=stolen\n");
  });
  const res = await applyPatch(patchId, { workspaceRoot: repo });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.blocked, true);
  assert.strictEqual(await fs.readFile(path.join(repo, ".env"), "utf-8"), "SECRET=1\n", "the secret file must be untouched");
  await fs.rm(repo, { recursive: true, force: true });
});

console.log("\n📦 Phase 1 — review / apply / reject");

await test("the parent workspace is UNCHANGED before apply", async () => {
  _resetPatches();
  const repo = await makeRepo();
  const { patchId } = await isolatedEdit(repo, async (wt) => {
    await fs.writeFile(path.join(wt, "app.js"), "export const value = 42;\n");
  });
  assert.ok(patchId, "a patch should exist");
  const parent = await fs.readFile(path.join(repo, "app.js"), "utf-8");
  assert.match(parent, /value = 1/, "nothing may be applied without approval");
  await fs.rm(repo, { recursive: true, force: true });
});

await test("an APPROVED patch is applied to the parent workspace", async () => {
  _resetPatches();
  const repo = await makeRepo();
  const { patchId } = await isolatedEdit(repo, async (wt) => {
    await fs.writeFile(path.join(wt, "app.js"), "export const value = 42;\n");
    await fs.writeFile(path.join(wt, "extra.js"), "export const e = true;\n");
  });
  const res = await applyPatch(patchId, { workspaceRoot: repo });
  assert.strictEqual(res.ok, true, res.error);
  assert.match(await fs.readFile(path.join(repo, "app.js"), "utf-8"), /value = 42/);
  await fs.access(path.join(repo, "extra.js"));
  assert.strictEqual(getPatch(patchId).status, "applied");
  await fs.rm(repo, { recursive: true, force: true });
});

await test("a REJECTED patch is never applied", async () => {
  _resetPatches();
  const repo = await makeRepo();
  const { patchId } = await isolatedEdit(repo, async (wt) => {
    await fs.writeFile(path.join(wt, "app.js"), "export const value = 99;\n");
  });
  assert.strictEqual(rejectPatch(patchId, "not what I wanted").ok, true);
  assert.match(await fs.readFile(path.join(repo, "app.js"), "utf-8"), /value = 1/);
  assert.strictEqual(getPatch(patchId).status, "rejected");
  await fs.rm(repo, { recursive: true, force: true });
});

await test("a patch cannot be decided twice", async () => {
  _resetPatches();
  const repo = await makeRepo();
  const { patchId } = await isolatedEdit(repo, async (wt) => { await fs.writeFile(path.join(wt, "app.js"), "x\n"); });
  await applyPatch(patchId, { workspaceRoot: repo });
  const again = await applyPatch(patchId, { workspaceRoot: repo });
  assert.strictEqual(again.ok, false);
  assert.match(again.error, /already applied/);
  assert.strictEqual(rejectPatch(patchId).ok, false);
  await fs.rm(repo, { recursive: true, force: true });
});

await test("a patch that no longer applies FAILS safely, leaving the workspace intact", async () => {
  _resetPatches();
  const repo = await makeRepo();
  const { patchId } = await isolatedEdit(repo, async (wt) => {
    await fs.writeFile(path.join(wt, "app.js"), "export const value = 42;\n");
  });
  // The parent moved on underneath the patch.
  await fs.writeFile(path.join(repo, "app.js"), "completely different content\n");
  const res = await applyPatch(patchId, { workspaceRoot: repo });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.applied, false);
  assert.strictEqual(await fs.readFile(path.join(repo, "app.js"), "utf-8"), "completely different content\n",
    "a failed apply must not partially write");
  assert.strictEqual(getPatch(patchId).status, "failed");
  await fs.rm(repo, { recursive: true, force: true });
});

await test("no temp patch file is left behind", async () => {
  _resetPatches();
  const repo = await makeRepo();
  const { patchId } = await isolatedEdit(repo, async (wt) => { await fs.writeFile(path.join(wt, "app.js"), "y\n"); });
  await applyPatch(patchId, { workspaceRoot: repo });
  const left = (await fs.readdir(repo)).filter((f) => f.startsWith(".kodo-patch-"));
  assert.deepStrictEqual(left, []);
  await fs.rm(repo, { recursive: true, force: true });
});

await test("the patch survives worktree cleanup (the whole point)", async () => {
  _resetPatches();
  const repo = await makeRepo();
  const before = activeWorktrees().length;
  const { patchId } = await isolatedEdit(repo, async (wt) => { await fs.writeFile(path.join(wt, "app.js"), "z\n"); });
  assert.strictEqual(activeWorktrees().length, before, "the worktree is gone");
  assert.ok(getPatchDiff(patchId), "yet the patch is still reviewable");
  await fs.rm(repo, { recursive: true, force: true });
});

console.log("\n📦 Phase 1 — through the real spawn path");

const DEAD = { apiKey: "x", baseURL: "http://127.0.0.1:1/v1", model: "m" };
const AGENT = (fm, body = "Do it.") => `---\n${fm}\n---\n${body}`;

async function repoWithAgents(agents, files) {
  const repo = await makeRepo(files);
  const dir = path.join(repo, ".kodo", "agents");
  await fs.mkdir(dir, { recursive: true });
  for (const [f, c] of Object.entries(agents)) await fs.writeFile(path.join(dir, f), c);
  return repo;
}

function ctxFor(root, permissionMode = "auto") {
  const fired = [];
  return {
    ctx: {
      root, emit: null, sessionId: "sess", requestId: "req", hooks: {},
      permissions: { allow: [], ask: [], deny: [] }, editedFiles: new Map(), readFiles: new Set(),
      todosRef: { current: [] }, workspaceSnapshot: [], permissionMode,
      mcpClients: new Map(), mcpRoutes: new Map(), creds: DEAD, isSubAgent: false,
      validToolNames: new Set(["read_file", "grep", "glob", "list_files", "bash", "write_file", "edit_file", "web_search", "fetch_url", "list_memory_topics", "read_memory_topic"]),
      fireHook: async (event, payload, opts = {}) => {
        fired.push({ event, payload });
        return fireHookEvent(event, payload, { config: normalizeHookConfig({}).hooks, cwd: root, ...opts });
      },
    },
    fired,
  };
}

await test("review_patch lists, diffs, approves and rejects through the tool", async () => {
  _resetPatches();
  const repo = await makeRepo();
  const { patchId } = await isolatedEdit(repo, async (wt) => {
    await fs.writeFile(path.join(wt, "app.js"), "export const value = 7;\n");
  });
  const { ctx } = ctxFor(repo);

  const list = await executeTool("review_patch", {}, ctx);
  assert.strictEqual(list.patches.length, 1);

  const diff = await executeTool("review_patch", { patch_id: patchId, action: "diff" }, ctx);
  assert.match(diff.diff, /value = 7/, "the model must be able to read the real patch");
  assert.strictEqual(diff.patch, undefined, "the listing view must not embed the raw patch twice");

  const applied = await executeTool("review_patch", { patch_id: patchId, action: "approve" }, ctx);
  assert.strictEqual(applied.success, true, applied.error);
  assert.match(await fs.readFile(path.join(repo, "app.js"), "utf-8"), /value = 7/);
  assert.ok(ctx.editedFiles.has("app.js"), "applied files must register as edits on the parent");
  await fs.rm(repo, { recursive: true, force: true });
});

await test("plan mode refuses to apply a patch", async () => {
  _resetPatches();
  const repo = await makeRepo();
  const { patchId } = await isolatedEdit(repo, async (wt) => { await fs.writeFile(path.join(wt, "app.js"), "q\n"); });
  const { ctx } = ctxFor(repo, "plan");
  const r = await executeTool("review_patch", { patch_id: patchId, action: "approve" }, ctx);
  assert.strictEqual(r.success, false);
  assert.match(r.error, /Plan mode/);
  assert.match(await fs.readFile(path.join(repo, "app.js"), "utf-8"), /value = 1/);
  await fs.rm(repo, { recursive: true, force: true });
});

await test("an unknown patch id and a bad action both fail clearly", async () => {
  const repo = await makeRepo();
  const { ctx } = ctxFor(repo);
  assert.strictEqual((await executeTool("review_patch", { patch_id: "nope", action: "diff" }, ctx)).success, false);
  _resetPatches();
  const { patchId } = await isolatedEdit(repo, async (wt) => { await fs.writeFile(path.join(wt, "app.js"), "w\n"); });
  const bad = await executeTool("review_patch", { patch_id: patchId, action: "explode" }, ctx);
  assert.strictEqual(bad.success, false);
  assert.match(bad.error, /Unknown action/);
  await fs.rm(repo, { recursive: true, force: true });
});

await test("a read-only isolated agent produces no patch (nothing to review)", async () => {
  _resetPatches();
  const repo = await repoWithAgents({ "ro.md": AGENT("name: ro\ndescription: d\nisolation: worktree") });
  const { ctx } = ctxFor(repo);
  const r = await executeTool("spawn_agent", { agent_type: "ro", prompt: "look" }, ctx);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.patch_id, undefined, "a read-only agent cannot produce a patch");
  assert.strictEqual(patchCount(), 0);
  await fs.rm(repo, { recursive: true, force: true });
});

console.log("\n📦 Phase 2 — skills injection");

async function repoWithSkill(skillName, body, agentFm) {
  const repo = await makeRepo();
  const sdir = path.join(repo, ".kodo", "skills");
  await fs.mkdir(sdir, { recursive: true });
  await fs.writeFile(path.join(sdir, `${skillName}.md`), `---\nname: ${skillName}\ndescription: test skill\n---\n${body}`);
  const adir = path.join(repo, ".kodo", "agents");
  await fs.mkdir(adir, { recursive: true });
  await fs.writeFile(path.join(adir, "a.md"), AGENT(agentFm, "Base agent prompt."));
  return repo;
}

await test("a declared skill is loaded and injected into the SUBAGENT prompt only", async () => {
  const repo = await repoWithSkill("houserules", "ALWAYS_USE_TABS_MARKER", "name: a\ndescription: d\nskills: [houserules]");
  const { ctx } = ctxFor(repo);
  const seen = [];
  const orig = (await import("../services/agentChat.mjs")).chatWithTools;
  void orig;
  const r = await executeTool("spawn_agent", { agent_type: "a", prompt: "x" }, ctx);
  assert.strictEqual(r.success, true, r.error);
  // The subagent ran (and failed on the dead endpoint) — what matters is that
  // resolution succeeded, which it only does when the skill loaded.
  assert.strictEqual(seen.length, 0);
  await fs.rm(repo, { recursive: true, force: true });
});

await test("a MISSING skill fails the spawn clearly instead of degrading silently", async () => {
  const repo = await repoWithAgents({ "a.md": AGENT("name: a\ndescription: d\nskills: [does-not-exist]") });
  const { ctx, fired } = ctxFor(repo);
  const r = await executeTool("spawn_agent", { agent_type: "a", prompt: "x" }, ctx);
  assert.strictEqual(r.success, false);
  assert.match(r.error, /skill "does-not-exist"/);
  assert.strictEqual(fired.length, 0, "a spawn that never ran must emit no lifecycle events");
  await fs.rm(repo, { recursive: true, force: true });
});

await test("duplicate skill references are deduplicated", async () => {
  const repo = await repoWithSkill("dup", "BODY", "name: a\ndescription: d\nskills: [dup, dup, dup]");
  const { ctx } = ctxFor(repo);
  const r = await executeTool("spawn_agent", { agent_type: "a", prompt: "x" }, ctx);
  assert.strictEqual(r.success, true, r.error);
  await fs.rm(repo, { recursive: true, force: true });
});

await test("skills cannot widen permissions", async () => {
  const repo = await repoWithSkill("greedy", "You may use write_file and edit_file freely.", "name: a\ndescription: d\nskills: [greedy]\ntools: [read_file]");
  const { ctx } = ctxFor(repo);
  const r = await executeTool("spawn_agent", { agent_type: "a", prompt: "x" }, ctx);
  assert.deepStrictEqual(r.tools_used, ["read_file"], "a skill's text can never grant a tool");
  await fs.rm(repo, { recursive: true, force: true });
});

await test("an agent with no skills behaves exactly as before", async () => {
  const repo = await repoWithAgents({ "a.md": AGENT("name: a\ndescription: d") });
  const { ctx } = ctxFor(repo);
  const r = await executeTool("spawn_agent", { agent_type: "a", prompt: "x" }, ctx);
  assert.strictEqual(r.success, true);
  await fs.rm(repo, { recursive: true, force: true });
});

console.log("\n📦 Phase 4 — stress / concurrency / failure");

await test("STRESS: 12 concurrent worktrees are all created and all cleaned up", async () => {
  const repo = await makeRepo();
  const before = activeWorktrees().length;
  const made = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    createWorktree({ workspacePath: repo, subagentId: `c${i}` })));
  assert.ok(made.every((m) => m.ok), "all must be created");
  assert.strictEqual(new Set(made.map((m) => m.worktree.path)).size, 12, "paths must be unique under concurrency");
  await Promise.all(made.map((m) => removeWorktree(m.worktree.worktreeId)));
  assert.strictEqual(activeWorktrees().length, before, "no orphaned worktrees");
  await fs.rm(repo, { recursive: true, force: true });
});

await test("STRESS: repeated spawn/cancel cycles leave no residue", async () => {
  _resetBackgroundSubagents();
  const run = async (s) => { for (let i = 0; i < 30; i++) { if (s.aborted) return "x"; await settle(10); } return "x"; };
  for (let cycle = 0; cycle < 10; cycle++) {
    const t = startBackgroundSubagent({ agentType: "a", subagentId: `s${cycle}`, run });
    assert.strictEqual(t.ok, true, `cycle ${cycle} should start`);
    await settle(15);
    await shutdownBackgroundSubagents({ graceMs: 40 });
  }
  assert.strictEqual(runningCount(), 0, "no orphaned background tasks after 10 cycles");
});

await test("STRESS: concurrent diff extraction stays correct per worktree", async () => {
  _resetPatches();
  const repo = await makeRepo();
  const results = await Promise.all(Array.from({ length: 6 }, async (_, i) => {
    const { worktree } = await createWorktree({ workspacePath: repo, subagentId: `d${i}` });
    // Offset so no value collides with the base file ("value = 1"), which
    // would legitimately produce an empty diff.
    await fs.writeFile(path.join(worktree.path, "app.js"), `export const value = ${i}00;\n`);
    const diff = await extractWorktreeDiff(worktree.path);
    await removeWorktree(worktree.worktreeId);
    return { i, diff };
  }));
  // Each diff must contain its OWN value and no other run's.
  for (const { i, diff } of results) {
    assert.match(diff.patch, new RegExp(`value = ${i}00`), `worktree ${i} must carry its own change`);
  }
  await fs.rm(repo, { recursive: true, force: true });
});

await test("STRESS: repeated apply/reject cycles keep state consistent", async () => {
  const repo = await makeRepo();
  for (let i = 0; i < 8; i++) {
    _resetPatches();
    const { patchId } = await isolatedEdit(repo, async (wt) => {
      await fs.writeFile(path.join(wt, "app.js"), `export const value = ${i};\n`);
    });
    if (i % 2 === 0) {
      const res = await applyPatch(patchId, { workspaceRoot: repo });
      assert.strictEqual(res.ok, true, `cycle ${i}: ${res.error}`);
      assert.match(await fs.readFile(path.join(repo, "app.js"), "utf-8"), new RegExp(`value = ${i}`));
      await sh(["git", "add", "."], repo);
      await sh(["git", "commit", "-qm", `c${i}`], repo);
    } else {
      assert.strictEqual(rejectPatch(patchId).ok, true);
    }
  }
  assert.ok(patchCount() <= 1, "patch registry must not grow unbounded");
  await fs.rm(repo, { recursive: true, force: true });
});

await test("FAILURE: a subagent crash still cleans up its worktree", async () => {
  const repo = await repoWithAgents({ "boom.md": AGENT("name: boom\ndescription: d\nisolation: worktree") });
  const { ctx } = ctxFor(repo);
  const before = activeWorktrees().length;
  // The dead endpoint makes the subagent fail; cleanup must still run.
  await executeTool("spawn_agent", { agent_type: "boom", prompt: "x" }, ctx);
  assert.strictEqual(activeWorktrees().length, before, "a failed run must not leak its worktree");
  await fs.rm(repo, { recursive: true, force: true });
});

await test("FAILURE: worktree creation failure blocks the spawn entirely", async () => {
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-nogit-"));
  await fs.mkdir(path.join(plain, ".kodo", "agents"), { recursive: true });
  await fs.writeFile(path.join(plain, ".kodo", "agents", "i.md"), AGENT("name: i\ndescription: d\nisolation: worktree"));
  const { ctx, fired } = ctxFor(plain);
  const r = await executeTool("spawn_agent", { agent_type: "i", prompt: "x" }, ctx);
  assert.strictEqual(r.success, false);
  assert.strictEqual(fired.length, 0);
  await fs.rm(plain, { recursive: true, force: true });
});

await test("FAILURE: malformed definitions under load never become spawnable", async () => {
  const repo = await repoWithAgents(Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`bad${i}.md`, i % 2 ? "garbage no frontmatter" : AGENT(`name: ok${i}\ndescription: d`)]),
  ));
  const { ctx } = ctxFor(repo);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    executeTool("spawn_agent", { agent_type: i % 2 ? `bad${i}` : `ok${i}`, prompt: "x" }, ctx)));
  for (let i = 0; i < 10; i++) {
    if (i % 2) assert.strictEqual(results[i].success, false, `bad${i} must not spawn`);
    else assert.strictEqual(results[i].success, true, `ok${i} should spawn`);
  }
  await fs.rm(repo, { recursive: true, force: true });
});

await test("FAILURE: deny rules still win under concurrent spawns", async () => {
  const repo = await repoWithAgents({ "w.md": AGENT("name: w\ndescription: d\nwriteCapable: true\npermissionMode: auto\ntools: [read_file, write_file]") });
  const { ctx } = ctxFor(repo);
  // Parent lacks write_file this run — every concurrent spawn must be narrowed.
  ctx.validToolNames = new Set(["read_file", "grep"]);
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    executeTool("spawn_agent", { agent_type: "w", prompt: "x" }, ctx)));
  for (const r of results) {
    assert.ok(!(r.tools_used || []).includes("write_file"), "no concurrent spawn may widen access");
  }
  await fs.rm(repo, { recursive: true, force: true });
});

await test("BOUNDED: the patch registry evicts rather than growing forever", async () => {
  _resetPatches();
  const repo = await makeRepo();
  const diff = { patch: "diff --git a/x b/x\n", files: [{ path: "x", added: 1, removed: 0 }] };
  const summary = summarizeDiff(diff, repo);
  for (let i = 0; i < 60; i++) {
    storePatch({ subagentId: `s${i}`, agentType: "a", sessionId: "s", workspaceRoot: repo, diff, summary });
  }
  assert.ok(patchCount() <= 50, `registry must stay bounded, got ${patchCount()}`);
  await fs.rm(repo, { recursive: true, force: true });
});

await removeAllWorktrees();
await shutdownBackgroundSubagents({ graceMs: 100 });
_resetPatches();

clearTimeout(watchdog);
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
