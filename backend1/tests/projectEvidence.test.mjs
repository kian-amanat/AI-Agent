/**
 * tests/projectEvidence.test.mjs
 * Run with: node tests/projectEvidence.test.mjs
 *
 * The evidence layer behind `/init`, and the runtime-vs-project boundary.
 *
 * The property under test throughout: KODO.md may only describe the user's
 * repository, using files that were actually read. Kodo's own runtime state —
 * memory topics, skills, subagents, hooks, MCP, anything under .kodo/ — is
 * never admissible as evidence about the project.
 */

import assert from "assert";
import path from "path";
import fs from "fs/promises";
import os from "os";

import { execFile } from "child_process";

import {
  collectProjectEvidence, deriveSignals, buildInitPrompt, validateKodoMd,
  evidenceFooter, isRuntimePath, RUNTIME_DIRS, RUNTIME_SURFACES,
  detectWorktreeRoots, isInsideWorktree, verifyClaims, extractSection,
  generateValidatedKodoMd, buildRepairPrompt, MAX_INIT_ATTEMPTS,
} from "../services/projectEvidence.mjs";
import { walkWorkspace } from "../agents/nodes/agent_loop.mjs";
import { createWorktree, removeWorktree, removeAllWorktrees } from "../services/worktreeManager.mjs";

const sh = (a, cwd) => new Promise((r) => execFile(a[0], a.slice(1), { cwd }, (e, o) => r(String(o || ""))));

async function makeGitRepo(files) {
  const ws = await makeRepo(files);
  await sh(["git", "init", "-q"], ws);
  await sh(["git", "config", "user.email", "t@e.com"], ws);
  await sh(["git", "config", "user.name", "T"], ws);
  await sh(["git", "add", "."], ws);
  await sh(["git", "commit", "-qm", "init"], ws);
  return ws;
}

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

async function makeRepo(files) {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-evidence-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(ws, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
  }
  return ws;
}
const gather = async (ws) => collectProjectEvidence(ws, { tree: await walkWorkspace(ws, 6) });

console.log("\n📦 evidence collection (real files only)");

await test("manifests that exist are read and recorded as inspected", async () => {
  const ws = await makeRepo({
    "package.json": JSON.stringify({ name: "demo", dependencies: { fastify: "^4.0.0" } }),
    "src/index.js": "console.log(1);",
  });
  const e = await gather(ws);
  assert.ok(e.filesInspected.includes("package.json"));
  assert.strictEqual(e.manifests.length, 1);
  assert.match(e.manifests[0].content, /fastify/);
  await fs.rm(ws, { recursive: true, force: true });
});

await test("a repo with NO manifests yields no evidence rather than invented evidence", async () => {
  const ws = await makeRepo({ "notes.txt": "hello", "src/thing.js": "x" });
  const e = await gather(ws);
  assert.deepStrictEqual(e.filesInspected, []);
  assert.deepStrictEqual(e.signals, []);
  assert.ok(e.treePaths.length > 0, "the tree is still evidence of layout");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("deeply nested manifests are ignored (a fixture is not the project shape)", async () => {
  const ws = await makeRepo({
    "package.json": '{"name":"root"}',
    "a/b/c/d/package.json": '{"name":"deep"}',
  });
  const e = await gather(ws);
  assert.deepStrictEqual(e.filesInspected, ["package.json"]);
  await fs.rm(ws, { recursive: true, force: true });
});

console.log("\n📦 RUNTIME data is never project evidence");

await test("isRuntimePath identifies Kodo's own directories", () => {
  for (const dir of RUNTIME_DIRS) {
    assert.ok(isRuntimePath(`${dir}/settings.json`), `${dir} must be runtime`);
    assert.ok(isRuntimePath(`nested/${dir}/x.md`));
  }
  assert.ok(!isRuntimePath("src/app.js"));
  assert.ok(!isRuntimePath("package.json"));
});

await test("nothing under .kodo/ enters the evidence, even a package.json", async () => {
  const ws = await makeRepo({
    "package.json": '{"name":"real","dependencies":{"fastify":"^4"}}',
    ".kodo/package.json": '{"name":"RUNTIME_LEAK","dependencies":{"express":"^4"}}',
    ".kodo/settings.json": '{"hooks":{}}',
    ".kodo/commands/deploy.md": "Deploy the app.",
    ".kodo/skills/ui.md": "---\nname: ui\n---\nUse tokens.",
  });
  const e = await gather(ws);
  assert.deepStrictEqual(e.filesInspected, ["package.json"], "only the real manifest may be evidence");
  const blob = JSON.stringify(e);
  assert.ok(!blob.includes("RUNTIME_LEAK"), "Kodo's own package.json must not be read as project evidence");
  assert.ok(!blob.includes(".kodo"), "no .kodo path may appear anywhere in the evidence");
  assert.ok(!e.signals.some((s) => s.tech === "express"), "a runtime manifest must not produce a project signal");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("the prompt contains no runtime data and no Kodo concepts", async () => {
  const ws = await makeRepo({
    "package.json": '{"name":"real"}',
    ".kodo/commands/secret.md": "SECRET_RUNTIME_BODY",
    ".kodo/settings.json": '{"hooks":{"PreToolUse":[]}}',
  });
  const { system, user } = buildInitPrompt(await gather(ws));
  assert.ok(!user.includes("SECRET_RUNTIME_BODY"));
  assert.ok(!user.includes(".kodo"));
  assert.ok(!user.includes("PreToolUse"));
  // And the instructions explicitly forbid describing Kodo.
  assert.match(system, /Never describe Kodo itself/);
  await fs.rm(ws, { recursive: true, force: true });
});

console.log("\n📦 signals carry provenance (no unsupported stack claims)");

await test("a dependency becomes a signal citing its manifest", () => {
  const signals = deriveSignals([
    { path: "backend/package.json", content: JSON.stringify({ dependencies: { fastify: "^4.1.0" } }) },
  ]);
  const fastify = signals.find((s) => s.tech === "fastify");
  assert.ok(fastify, "the dependency must be detected");
  assert.strictEqual(fastify.source, "backend/package.json");
  assert.match(fastify.basis, /listed in dependencies/);
});

await test("a technology NOT in any manifest produces no signal", () => {
  const signals = deriveSignals([{ path: "package.json", content: '{"name":"x"}' }]);
  for (const guess of ["react", "next", "postgres", "fastify", "express"]) {
    assert.ok(!signals.some((s) => s.tech === guess), `${guess} must not be inferred without evidence`);
  }
});

await test("a directory name alone is never a signal", async () => {
  const ws = await makeRepo({
    "package.json": '{"name":"x"}',
    "backend/server/index.js": "x",
    "frontend/pages/index.js": "x",
  });
  const e = await gather(ws);
  const techs = e.signals.map((s) => s.tech);
  assert.ok(!techs.includes("express") && !techs.includes("next"), "layout is not evidence of a framework");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("malformed JSON yields no signals rather than guesses", () => {
  assert.deepStrictEqual(deriveSignals([{ path: "package.json", content: "{ not json" }]), []);
});

await test("scripts are captured verbatim so commands can be cited", () => {
  const signals = deriveSignals([
    { path: "package.json", content: JSON.stringify({ scripts: { test: "node t.mjs", dev: "next dev" } }) },
  ]);
  const t = signals.find((s) => s.tech === "script:test");
  assert.match(t.basis, /node t\.mjs/);
});

console.log("\n📦 prompt demands verified/inferred separation");

await test("the prompt requires both sections and citations", async () => {
  const ws = await makeRepo({ "package.json": '{"name":"x"}' });
  const { system } = buildInitPrompt(await gather(ws));
  assert.match(system, /## Verified facts/);
  assert.match(system, /## Inferred \(unverified\)/);
  assert.match(system, /MUST cite its source file/);
  assert.match(system, /"Likely" or "Possibly"/);
  assert.match(system, /ONLY evidence/);
  await fs.rm(ws, { recursive: true, force: true });
});

await test("the prompt lists exactly the files inspected", async () => {
  const ws = await makeRepo({ "package.json": '{"name":"x"}', "tsconfig.json": "{}" });
  const e = await gather(ws);
  const { user } = buildInitPrompt(e);
  assert.match(user, /## Files inspected \(2\)/);
  for (const f of e.filesInspected) assert.ok(user.includes(`- ${f}`));
  await fs.rm(ws, { recursive: true, force: true });
});

console.log("\n📦 output validation (the guard)");

const GOOD = [
  "# demo",
  "## Verified facts",
  "- Uses Fastify (`package.json` dependency \"fastify\")",
  "## Inferred (unverified)",
  "- Likely a REST API; confirmed by reading the route files.",
  "## Layout",
  "- `src/` holds the source",
].join("\n");

await test("a well-formed document passes", async () => {
  const ws = await makeRepo({ "package.json": '{"name":"demo"}' });
  const { ok, violations } = validateKodoMd(GOOD, await gather(ws));
  assert.strictEqual(ok, true, JSON.stringify(violations));
  await fs.rm(ws, { recursive: true, force: true });
});

await test("a MISSING verified/inferred split is flagged", async () => {
  const ws = await makeRepo({ "package.json": "{}" });
  const e = await gather(ws);
  const { ok, violations } = validateKodoMd("# demo\n\nThis is a Next.js app.", e);
  assert.strictEqual(ok, false);
  assert.strictEqual(violations.filter((v) => v.kind === "missing-section").length, 2);
  await fs.rm(ws, { recursive: true, force: true });
});

await test("RUNTIME LEAKAGE into KODO.md is caught", async () => {
  const ws = await makeRepo({ "package.json": "{}" });
  const e = await gather(ws);
  for (const bad of [
    `${GOOD}\n- Run /hooks to see configuration`,
    `${GOOD}\n- Config lives in .kodo/settings.json`,
    `${GOOD}\n- A subagent handles review`,
    `${GOOD}\n- The MCP server provides tools`,
    `${GOOD}\n- See the memory topic for details`,
  ]) {
    const { ok, violations } = validateKodoMd(bad, e);
    assert.strictEqual(ok, false, `should be flagged: ${bad.split("\n").pop()}`);
    assert.ok(violations.some((v) => v.kind === "runtime-leak"));
  }
  await fs.rm(ws, { recursive: true, force: true });
});

await test("every runtime surface is detected", async () => {
  const ws = await makeRepo({ "package.json": "{}" });
  const e = await gather(ws);
  for (const surface of RUNTIME_SURFACES) {
    const { violations } = validateKodoMd(`${GOOD}\n- see ${surface} for more`, e);
    assert.ok(violations.some((v) => v.kind === "runtime-leak"), `${surface} must be caught`);
  }
  await fs.rm(ws, { recursive: true, force: true });
});

await test("a FABRICATED citation is caught", async () => {
  const ws = await makeRepo({ "package.json": '{"name":"demo"}' });
  const e = await gather(ws);
  const { ok, violations } = validateKodoMd(
    `${GOOD}\n- Uses Poetry (\`pyproject.toml\` present)`, e,
  );
  assert.strictEqual(ok, false);
  assert.ok(violations.some((v) => v.kind === "unverified-citation" && /pyproject\.toml/.test(v.detail)));
  await fs.rm(ws, { recursive: true, force: true });
});

await test("citing a file that WAS inspected is accepted", async () => {
  const ws = await makeRepo({ "package.json": '{"name":"demo"}', "tsconfig.json": "{}" });
  const e = await gather(ws);
  const { ok } = validateKodoMd(`${GOOD}\n- TypeScript configured (\`tsconfig.json\`)`, e);
  assert.strictEqual(ok, true);
  await fs.rm(ws, { recursive: true, force: true });
});

console.log("\n📦 provenance footer");

await test("the footer lists every inspected file", async () => {
  const ws = await makeRepo({ "package.json": "{}", "tsconfig.json": "{}" });
  const e = await gather(ws);
  const footer = evidenceFooter(e);
  assert.match(footer, /2 inspected file\(s\)/);
  assert.match(footer, /package\.json/);
  assert.match(footer, /tsconfig\.json/);
  await fs.rm(ws, { recursive: true, force: true });
});

await test("with no manifests the footer says so instead of implying evidence", async () => {
  const ws = await makeRepo({ "notes.txt": "x" });
  const footer = evidenceFooter(await gather(ws));
  assert.match(footer, /no manifest files were found/i);
  await fs.rm(ws, { recursive: true, force: true });
});

console.log("\n📦 BUG 1 — worktrees are structurally excluded");

await test("a worktree INSIDE the project is excluded, project files still found", async () => {
  const ws = await makeGitRepo({
    "package.json": '{"name":"real-project","dependencies":{"fastify":"^4"}}',
    "src/app.js": "x",
  });
  // A worktree living in the project root — the exact reported bug shape.
  await sh(["git", "worktree", "add", "-q", "--detach", ".error-handling-worktree", "HEAD"], ws);
  await fs.writeFile(path.join(ws, ".error-handling-worktree", "package.json"),
    '{"name":"WORKTREE_LEAK","dependencies":{"express":"^4"}}');

  const e = await gather(ws);
  assert.ok(e.excludedWorktrees.includes(".error-handling-worktree"), "the worktree must be detected");
  assert.deepStrictEqual(e.filesInspected, ["package.json"], "only the real manifest may be inspected");
  const blob = JSON.stringify(e);
  assert.ok(!blob.includes("WORKTREE_LEAK"), "a worktree manifest must never be evidence");
  assert.ok(!blob.includes(".error-handling-worktree/"), "no worktree path may reach the tree");
  assert.ok(!e.signals.some((s) => s.tech === "express"), "no signal from a worktree");
  assert.ok(e.signals.some((s) => s.tech === "fastify"), "the real project's signal survives");

  await sh(["git", "worktree", "remove", "--force", ".error-handling-worktree"], ws);
  await fs.rm(ws, { recursive: true, force: true });
});

await test("detection is NOT name-based — an innocuously named worktree is excluded too", async () => {
  const ws = await makeGitRepo({ "package.json": '{"name":"real"}' });
  await sh(["git", "worktree", "add", "-q", "--detach", "feature-x", "HEAD"], ws);
  await fs.writeFile(path.join(ws, "feature-x", "package.json"), '{"name":"ALSO_A_WORKTREE"}');
  const e = await gather(ws);
  assert.ok(e.excludedWorktrees.includes("feature-x"), "name is irrelevant — structure decides");
  assert.ok(!JSON.stringify(e).includes("ALSO_A_WORKTREE"));
  await sh(["git", "worktree", "remove", "--force", "feature-x"], ws);
  await fs.rm(ws, { recursive: true, force: true });
});

await test("a DETACHED worktree (git metadata pruned) is still excluded", async () => {
  const ws = await makeGitRepo({ "package.json": '{"name":"real"}' });
  await sh(["git", "worktree", "add", "-q", "--detach", "orphan", "HEAD"], ws);
  await fs.writeFile(path.join(ws, "orphan", "package.json"), '{"name":"ORPHAN_LEAK"}');
  // Destroy git's record; the directory (and its .git FILE) remain.
  await fs.rm(path.join(ws, ".git", "worktrees"), { recursive: true, force: true });
  await sh(["git", "worktree", "prune"], ws);

  const listed = await sh(["git", "worktree", "list", "--porcelain"], ws);
  assert.ok(!listed.includes("orphan"), "git no longer reports it — only the .git marker remains");

  const e = await gather(ws);
  assert.ok(e.excludedWorktrees.includes("orphan"), "the .git FILE marker must still exclude it");
  assert.ok(!JSON.stringify(e).includes("ORPHAN_LEAK"));
  await fs.rm(ws, { recursive: true, force: true });
});

await test("a NESTED worktree is excluded along with everything under it", async () => {
  const ws = await makeGitRepo({ "package.json": '{"name":"real"}', "apps/keep.txt": "x" });
  await sh(["git", "worktree", "add", "-q", "--detach", "apps/nested-wt", "HEAD"], ws);
  await fs.writeFile(path.join(ws, "apps", "nested-wt", "package.json"), '{"name":"NESTED_LEAK"}');
  const e = await gather(ws);
  assert.ok(e.excludedWorktrees.includes("apps/nested-wt"));
  assert.ok(!JSON.stringify(e).includes("NESTED_LEAK"));
  assert.ok(e.treePaths.some((p) => p.startsWith("apps/keep")), "sibling project files survive");
  await sh(["git", "worktree", "remove", "--force", "apps/nested-wt"], ws);
  await fs.rm(ws, { recursive: true, force: true });
});

await test("a Kodo-created worktree is excluded via the registry", async () => {
  const ws = await makeGitRepo({ "package.json": '{"name":"real"}' });
  const created = await createWorktree({ workspacePath: ws, subagentId: "sub" });
  try {
    // Kodo's worktrees live in tmpdir, outside the workspace — so they can
    // never contaminate it, and the registry lookup must not crash on that.
    const e = await gather(ws);
    assert.deepStrictEqual(e.filesInspected, ["package.json"]);
    assert.ok(!JSON.stringify(e).includes("kodo-worktrees"));
  } finally {
    if (created.ok) await removeWorktree(created.worktree.worktreeId);
    await removeAllWorktrees();
    await fs.rm(ws, { recursive: true, force: true });
  }
});

await test("REMOVING a worktree immediately makes that path scannable again", async () => {
  const ws = await makeGitRepo({ "package.json": '{"name":"real"}' });
  await sh(["git", "worktree", "add", "-q", "--detach", "temp", "HEAD"], ws);
  assert.ok((await gather(ws)).excludedWorktrees.includes("temp"), "excluded while it is a worktree");

  await sh(["git", "worktree", "remove", "--force", "temp"], ws);
  // The path now becomes an ordinary project directory.
  await fs.mkdir(path.join(ws, "temp"), { recursive: true });
  await fs.writeFile(path.join(ws, "temp", "notes.txt"), "now real project content");

  const after = await gather(ws);
  assert.ok(!after.excludedWorktrees.includes("temp"), "no stale exclusion — detection is live, not cached");
  assert.ok(after.treePaths.some((p) => p.startsWith("temp")), "the path is scannable again");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("a non-git workspace still works (no worktrees to detect)", async () => {
  const ws = await makeRepo({ "package.json": '{"name":"plain"}' });
  const e = await gather(ws);
  assert.deepStrictEqual(e.excludedWorktrees, []);
  assert.deepStrictEqual(e.filesInspected, ["package.json"]);
  await fs.rm(ws, { recursive: true, force: true });
});

await test("isInsideWorktree matches the root and its descendants only", () => {
  const roots = new Set(["wt", "apps/nested"]);
  assert.ok(isInsideWorktree("wt", roots));
  assert.ok(isInsideWorktree("wt/package.json", roots));
  assert.ok(isInsideWorktree("apps/nested/src/x.js", roots));
  assert.ok(!isInsideWorktree("wtx/package.json", roots), "prefix must not over-match");
  assert.ok(!isInsideWorktree("apps/other/x.js", roots));
});

console.log("\n📦 BUG 2 — no partially-verified sentences");

const EV = {
  filesInspected: ["package.json"],
  treePaths: ["package.json", "src/"],
  manifests: [{ path: "package.json", content: JSON.stringify({ scripts: { test: "node t.mjs" } }) }],
};

await test("THE REPORTED BUG: a fabricated command in a verified claim is rejected", async () => {
  const doc = [
    "# demo", "## Verified facts",
    "- Frontend uses Node.js because `package.json` contains `npm install --prefix frontend`",
    "## Inferred (unverified)", "- None.",
  ].join("\n");
  const v = verifyClaims(doc, EV);
  assert.ok(v.some((x) => x.kind === "fabricated-command"),
    "a command not present in any inspected file must be rejected even though the FILE citation is valid");
});

await test("a command that DOES appear verbatim is accepted", () => {
  const doc = ["# d", "## Verified facts", "- Tests run via `node t.mjs` (`package.json`)", "## Inferred (unverified)", "- None."].join("\n");
  assert.deepStrictEqual(verifyClaims(doc, EV), []);
});

await test("an uncited command/workflow assertion cannot be verified", () => {
  const doc = ["# d", "## Verified facts", "- The project is deployed to production via CI", "## Inferred (unverified)", "- None."].join("\n");
  assert.ok(verifyClaims(doc, EV).some((x) => x.kind === "uncited-claim"));
});

await test("inferred scripts and build commands never pass as verified", () => {
  for (const claim of [
    "- Build with `npm run build`",
    "- Deploy using `docker compose up -d`",
    "- Start the server with `npm start`",
  ]) {
    const doc = ["# d", "## Verified facts", claim, "## Inferred (unverified)", "- None."].join("\n");
    assert.ok(verifyClaims(doc, EV).length > 0, `must reject: ${claim}`);
  }
});

await test("package.json scripts are not interpreted beyond their literal contents", () => {
  // "test" exists literally; "typecheck" does not — inventing it must fail.
  const bad = ["# d", "## Verified facts", "- Typecheck with `npm run typecheck` (`package.json`)", "## Inferred (unverified)", "- None."].join("\n");
  assert.ok(verifyClaims(bad, EV).some((x) => x.kind === "fabricated-command"));
});

await test("moving the same claim to Inferred (properly hedged) is accepted", () => {
  const doc = [
    "# d", "## Verified facts", "- Tests run via `node t.mjs` (`package.json`)",
    "## Inferred (unverified)", "- Likely deployed via CI; confirmed by reading the workflow files.",
  ].join("\n");
  assert.deepStrictEqual(verifyClaims(doc, EV), []);
});

await test("an UNHEDGED inferred claim is rejected", () => {
  const doc = ["# d", "## Verified facts", "- None.", "## Inferred (unverified)", "- The app is deployed to Vercel."].join("\n");
  assert.ok(verifyClaims(doc, EV).some((x) => x.kind === "unhedged-inference"));
});

await test("extractSection reads only the requested section's bullets", () => {
  const doc = ["# t", "## Verified facts", "- A", "- B", "## Inferred (unverified)", "- Likely C", "## Layout", "- D"].join("\n");
  assert.deepStrictEqual(extractSection(doc, "Verified facts"), ["A", "B"]);
  assert.deepStrictEqual(extractSection(doc, "Inferred (unverified)"), ["Likely C"]);
});

await test("every verified statement traces to an inspected source", () => {
  const doc = ["# d", "## Verified facts", "- Uses Poetry (`pyproject.toml`)", "## Inferred (unverified)", "- None."].join("\n");
  const v = verifyClaims(doc, EV);
  // In Verified, an uninspected citation invalidates the WHOLE bullet — a
  // stronger finding than the document-wide citation notice.
  assert.ok(v.some((x) => x.kind === "unverified-verified-claim"), JSON.stringify(v));
  assert.match(v[0].detail, /move the whole bullet/);
});

console.log("\n📦 BUG 3 — invalid output is regenerated, never written");

const VALID_DOC = [
  "# demo", "## Verified facts", "- Tests run via `node t.mjs` (`package.json`)",
  "## Inferred (unverified)", "- None.", "## Layout", "- `src/` holds source",
].join("\n");
const INVALID_DOC = ["# demo", "This is a Next.js app deployed to Vercel."].join("\n");

await test("a valid first draft is accepted without retrying", async () => {
  let calls = 0;
  const r = await generateValidatedKodoMd({
    evidence: EV, generate: async () => { calls++; return VALID_DOC; },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls, 1, "no needless regeneration");
  assert.strictEqual(r.attemptsUsed, 1);
});

await test("an INVALID draft triggers regeneration, and the valid retry is used", async () => {
  let calls = 0;
  const r = await generateValidatedKodoMd({
    evidence: EV, generate: async () => { calls++; return calls === 1 ? INVALID_DOC : VALID_DOC; },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls, 2, "the invalid draft must be discarded and regenerated");
  assert.strictEqual(r.attemptsUsed, 2);
  assert.ok(r.attempts[0].violations.length > 0, "the first attempt's violations are recorded");
});

await test("validator feedback is INJECTED into the next prompt", async () => {
  const prompts = [];
  await generateValidatedKodoMd({
    evidence: EV,
    generate: async ({ user }) => { prompts.push(user); return prompts.length === 1 ? INVALID_DOC : VALID_DOC; },
  });
  assert.strictEqual(prompts.length, 2);
  assert.ok(!/REJECTED/.test(prompts[0]), "the first prompt carries no feedback");
  assert.match(prompts[1], /REJECTED/, "the retry must carry corrective feedback");
  assert.match(prompts[1], /missing-section/, "and must name the specific failures");
});

await test("retries are BOUNDED — a never-improving model terminates", async () => {
  let calls = 0;
  const r = await generateValidatedKodoMd({
    evidence: EV, generate: async () => { calls++; return INVALID_DOC; },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(calls, MAX_INIT_ATTEMPTS, `must stop at ${MAX_INIT_ATTEMPTS} attempts`);
  assert.ok(r.violations.length > 0, "the final violations are returned for the user");
});

await test("a custom maxAttempts is honoured (no infinite loop possible)", async () => {
  let calls = 0;
  const r = await generateValidatedKodoMd({
    evidence: EV, maxAttempts: 2, generate: async () => { calls++; return INVALID_DOC; },
  });
  assert.strictEqual(calls, 2);
  assert.strictEqual(r.ok, false);
});

await test("a THROWING generator is retried, then fails cleanly", async () => {
  let calls = 0;
  const r = await generateValidatedKodoMd({
    evidence: EV, generate: async () => { calls++; throw new Error("provider down"); },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(calls, MAX_INIT_ATTEMPTS);
  assert.ok(r.attempts.every((a) => /provider down/.test(a.error)));
});

await test("an EMPTY response is treated as a failure, not as content", async () => {
  let calls = 0;
  const r = await generateValidatedKodoMd({
    evidence: EV, generate: async () => { calls++; return calls === 1 ? "" : VALID_DOC; },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls, 2);
});

await test("a code-fenced response is unwrapped before validation", async () => {
  const r = await generateValidatedKodoMd({
    evidence: EV, generate: async () => "```markdown\n" + VALID_DOC + "\n```",
  });
  assert.strictEqual(r.ok, true);
  assert.ok(!r.content.includes("```"));
});

await test("buildRepairPrompt groups violations and restates the rules", () => {
  const p = buildRepairPrompt([
    { kind: "fabricated-command", detail: "quotes `npm run build`" },
    { kind: "runtime-leak", detail: "mentions /hooks" },
  ]);
  assert.match(p, /REJECTED/);
  assert.match(p, /### fabricated-command/);
  assert.match(p, /### runtime-leak/);
  assert.match(p, /Never invent a command/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
