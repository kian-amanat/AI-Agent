/**
 * tests/subagentRuntime.test.mjs
 * Run with: node tests/subagentRuntime.test.mjs
 *
 * Worktree isolation and background execution as REAL runtime:
 *   • real `git worktree` against real temporary repositories
 *   • real async execution proven by observing the foreground continue
 *   • cleanup on success, failure, abort and shutdown
 *
 * Nothing here mocks git or fakes concurrency.
 */

import assert from "assert";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { execFile } from "child_process";

import {
  createWorktree, removeWorktree, getWorktree, activeWorktrees,
  removeAllWorktrees, findRepoRoot, WORKTREE_ROOT_PATH,
} from "../services/worktreeManager.mjs";
import {
  startBackgroundSubagent, getBackgroundTask, listBackgroundTasks,
  cancelBackgroundTask, cancelSessionTasks, runningCount,
  shutdownBackgroundSubagents, _resetBackgroundSubagents,
} from "../services/backgroundSubagents.mjs";
import { parseAgentDefinition, loadSubagentRegistry, describeAgents } from "../services/subagentRegistry.mjs";
import { executeTool } from "../agents/nodes/agent_loop.mjs";
import { normalizeHookConfig, fireHookEvent } from "../services/hooks.mjs";

// Watchdog: detached background promises keep timers alive, so a stall must
// surface as a failure rather than a silent hang.
const watchdog = setTimeout(() => {
  console.error("\n❌ WATCHDOG: suite stalled — forcing exit\n");
  process.exit(1);
}, 60_000);

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

const sh = (args, cwd) => new Promise((resolve) => execFile(args[0], args.slice(1), { cwd }, (e, o) => resolve(String(o || ""))));
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/** A real git repo with one commit. */
async function makeRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-repo-"));
  await sh(["git", "init", "-q"], dir);
  await sh(["git", "config", "user.email", "t@example.com"], dir);
  await sh(["git", "config", "user.name", "Test"], dir);
  await fs.writeFile(path.join(dir, "app.js"), "export const value = 1;\n");
  await sh(["git", "add", "."], dir);
  await sh(["git", "commit", "-qm", "init"], dir);
  return dir;
}

console.log("\n📦 worktree runtime (real git)");

await test("a real worktree is created with the repo's content", async () => {
  const repo = await makeRepo();
  const r = await createWorktree({ workspacePath: repo, subagentId: "sub_a" });
  assert.strictEqual(r.ok, true, r.error);
  // It's a real checkout, not a renamed path.
  const content = await fs.readFile(path.join(r.worktree.path, "app.js"), "utf-8");
  assert.match(content, /export const value = 1/);
  const list = await sh(["git", "worktree", "list"], repo);
  assert.ok(list.includes(r.worktree.path), "git itself must know about it");
  await removeWorktree(r.worktree.worktreeId);
  await fs.rm(repo, { recursive: true, force: true });
});

await test("edits inside the worktree do NOT touch the parent workspace", async () => {
  const repo = await makeRepo();
  const { worktree } = await createWorktree({ workspacePath: repo, subagentId: "sub_iso" });
  try {
    await fs.writeFile(path.join(worktree.path, "app.js"), "export const value = 999;\n");
    await fs.writeFile(path.join(worktree.path, "new-file.txt"), "only in worktree");
    const parent = await fs.readFile(path.join(repo, "app.js"), "utf-8");
    assert.match(parent, /value = 1/, "the parent file must be unchanged");
    await assert.rejects(() => fs.access(path.join(repo, "new-file.txt")), "a new file must not appear in the parent");
  } finally {
    await removeWorktree(worktree.worktreeId);
    await fs.rm(repo, { recursive: true, force: true });
  }
});

await test("worktree paths are collision-safe for the same subagent id", async () => {
  const repo = await makeRepo();
  const a = await createWorktree({ workspacePath: repo, subagentId: "same" });
  const b = await createWorktree({ workspacePath: repo, subagentId: "same" });
  assert.notStrictEqual(a.worktree.path, b.worktree.path);
  await removeWorktree(a.worktree.worktreeId);
  await removeWorktree(b.worktree.worktreeId);
  await fs.rm(repo, { recursive: true, force: true });
});

await test("worktrees are created only under the controlled root", async () => {
  const repo = await makeRepo();
  const { worktree } = await createWorktree({ workspacePath: repo, subagentId: "x" });
  assert.ok(path.resolve(worktree.path).startsWith(path.resolve(WORKTREE_ROOT_PATH) + path.sep));
  await removeWorktree(worktree.worktreeId);
  await fs.rm(repo, { recursive: true, force: true });
});

await test("a NON-git workspace fails clearly instead of running unisolated", async () => {
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-plain-"));
  const r = await createWorktree({ workspacePath: plain, subagentId: "x" });
  assert.strictEqual(r.ok, false);
  assert.ok(/requires a git repository/.test(r.error));
  assert.strictEqual(await findRepoRoot(plain), null);
  await fs.rm(plain, { recursive: true, force: true });
});

await test("cleanup removes the worktree and nothing else", async () => {
  const repo = await makeRepo();
  const { worktree } = await createWorktree({ workspacePath: repo, subagentId: "clean" });
  const r = await removeWorktree(worktree.worktreeId);
  assert.strictEqual(r.removed, true);
  await assert.rejects(() => fs.access(worktree.path), "the worktree dir must be gone");
  await fs.access(path.join(repo, "app.js")); // parent untouched
  assert.strictEqual(getWorktree(worktree.worktreeId), null);
  await fs.rm(repo, { recursive: true, force: true });
});

await test("cleanup is idempotent", async () => {
  const repo = await makeRepo();
  const { worktree } = await createWorktree({ workspacePath: repo, subagentId: "idem" });
  assert.strictEqual((await removeWorktree(worktree.worktreeId)).removed, true);
  const second = await removeWorktree(worktree.worktreeId);
  assert.strictEqual(second.ok, true, "a repeat removal must be a safe no-op");
  assert.strictEqual(second.removed, false);
  await fs.rm(repo, { recursive: true, force: true });
});

await test("an UNKNOWN id is refused — only Kodo-created worktrees are removable", async () => {
  const r = await removeWorktree("wt_not_created_by_us");
  assert.strictEqual(r.removed, false);
  assert.ok(/unknown or already removed/.test(r.reason));
});

await test("cleanup survives the directory already being gone (crash recovery)", async () => {
  const repo = await makeRepo();
  const { worktree } = await createWorktree({ workspacePath: repo, subagentId: "crash" });
  await fs.rm(worktree.path, { recursive: true, force: true }); // simulate a crash
  const r = await removeWorktree(worktree.worktreeId);
  assert.strictEqual(r.ok, true, "must reconcile rather than fail");
  await fs.rm(repo, { recursive: true, force: true });
});

await test("removeAllWorktrees clears everything tracked", async () => {
  const repo = await makeRepo();
  await createWorktree({ workspacePath: repo, subagentId: "a" });
  await createWorktree({ workspacePath: repo, subagentId: "b" });
  assert.ok(activeWorktrees().length >= 2);
  await removeAllWorktrees();
  assert.strictEqual(activeWorktrees().length, 0);
  await fs.rm(repo, { recursive: true, force: true });
});

console.log("\n📦 background execution (real async)");

await test("the caller is NOT blocked — foreground continues while the task runs", async () => {
  _resetBackgroundSubagents();
  const order = [];
  const started = startBackgroundSubagent({
    agentType: "slow", subagentId: "s1", sessionId: "sess",
    run: async () => { await settle(200); order.push("background-finished"); return "report"; },
  });
  assert.strictEqual(started.ok, true);
  // This line runs while the task is still in flight — the proof of real async.
  order.push("foreground-continued");
  assert.strictEqual(getBackgroundTask(started.taskId).status, "running");

  await settle(350);
  assert.deepStrictEqual(order, ["foreground-continued", "background-finished"],
    "the foreground must proceed before the task completes");
  assert.strictEqual(getBackgroundTask(started.taskId).status, "done");
});

await test("completion is observable and carries the report", async () => {
  _resetBackgroundSubagents();
  const { taskId } = startBackgroundSubagent({ agentType: "a", subagentId: "s", run: async () => "the findings" });
  await settle(80);
  const t = getBackgroundTask(taskId);
  assert.strictEqual(t.status, "done");
  assert.strictEqual(t.result, "the findings");
  assert.ok(t.durationMs >= 0);
});

await test("failure is observable and does not throw into the foreground", async () => {
  _resetBackgroundSubagents();
  const { taskId } = startBackgroundSubagent({ agentType: "a", subagentId: "s", run: async () => { throw new Error("boom"); } });
  await settle(80);
  const t = getBackgroundTask(taskId);
  assert.strictEqual(t.status, "error");
  assert.match(t.error, /boom/);
  assert.strictEqual(t.result, null);
});

await test("cancellation is honoured via the abort signal", async () => {
  _resetBackgroundSubagents();
  const { taskId } = startBackgroundSubagent({
    agentType: "a", subagentId: "s",
    run: async (signal) => { for (let i = 0; i < 40; i++) { if (signal.aborted) return "stopped"; await settle(20); } return "finished"; },
  });
  await settle(50);
  assert.strictEqual(cancelBackgroundTask(taskId), true);
  await settle(120);
  assert.strictEqual(getBackgroundTask(taskId).status, "cancelled");
});

await test("concurrency is BOUNDED — the 5th concurrent task is refused", async () => {
  _resetBackgroundSubagents();
  const run = async (signal) => { for (let i = 0; i < 50; i++) { if (signal.aborted) return "x"; await settle(20); } return "x"; };
  const ok = [];
  for (let i = 0; i < 4; i++) ok.push(startBackgroundSubagent({ agentType: "a", subagentId: `s${i}`, run }));
  assert.ok(ok.every((r) => r.ok));
  assert.strictEqual(runningCount(), 4);
  const overflow = startBackgroundSubagent({ agentType: "a", subagentId: "s5", run });
  assert.strictEqual(overflow.ok, false, "must refuse rather than queue unboundedly");
  assert.match(overflow.error, /Too many background subagents/);
  await shutdownBackgroundSubagents({ graceMs: 100 });
});

await test("onSettled cleanup runs on success, failure AND cancellation", async () => {
  _resetBackgroundSubagents();
  const cleaned = [];
  const mk = (name, run) => startBackgroundSubagent({
    agentType: name, subagentId: name, run,
    onSettled: async (rec) => { cleaned.push(`${name}:${rec.status}`); return { ok: true }; },
  });
  mk("okTask", async () => "fine");
  mk("failTask", async () => { throw new Error("nope"); });
  const c = mk("cancelTask", async (s) => { for (let i = 0; i < 30; i++) { if (s.aborted) return "x"; await settle(20); } return "x"; });
  await settle(40);
  cancelBackgroundTask(c.taskId);
  await settle(200);
  assert.ok(cleaned.includes("okTask:done"));
  assert.ok(cleaned.includes("failTask:error"));
  assert.ok(cleaned.some((x) => x.startsWith("cancelTask:")), "cleanup must run even when cancelled");
});

await test("a failing cleanup is recorded, not thrown", async () => {
  _resetBackgroundSubagents();
  const { taskId } = startBackgroundSubagent({
    agentType: "a", subagentId: "s", run: async () => "ok",
    onSettled: async () => { throw new Error("cleanup exploded"); },
  });
  await settle(100);
  assert.match(getBackgroundTask(taskId).cleanup.error, /cleanup exploded/);
});

await test("session cancellation stops that session's tasks only", async () => {
  _resetBackgroundSubagents();
  const run = async (s) => { for (let i = 0; i < 30; i++) { if (s.aborted) return "x"; await settle(20); } return "x"; };
  const mine = startBackgroundSubagent({ agentType: "a", subagentId: "1", sessionId: "s1", run });
  const other = startBackgroundSubagent({ agentType: "a", subagentId: "2", sessionId: "s2", run });
  assert.strictEqual(cancelSessionTasks("s1"), 1);
  await settle(120);
  assert.strictEqual(getBackgroundTask(mine.taskId).status, "cancelled");
  assert.strictEqual(getBackgroundTask(other.taskId).status, "running");
  await shutdownBackgroundSubagents({ graceMs: 100 });
});

await test("shutdown leaves no running task behind", async () => {
  _resetBackgroundSubagents();
  const run = async (s) => { for (let i = 0; i < 40; i++) { if (s.aborted) return "x"; await settle(20); } return "x"; };
  startBackgroundSubagent({ agentType: "a", subagentId: "1", run });
  startBackgroundSubagent({ agentType: "a", subagentId: "2", run });
  const { aborted } = await shutdownBackgroundSubagents({ graceMs: 200 });
  assert.strictEqual(aborted, 2);
  assert.strictEqual(runningCount(), 0, "no dangling background task after shutdown");
});

await test("the public view never exposes the AbortController", async () => {
  _resetBackgroundSubagents();
  const { taskId } = startBackgroundSubagent({ agentType: "a", subagentId: "s", run: async () => "x" });
  await settle(60);
  assert.strictEqual(getBackgroundTask(taskId).controller, undefined);
  assert.ok(!JSON.stringify(listBackgroundTasks()).includes("controller"));
});

console.log("\n📦 spawn path: isolation + background + combined");

const DEAD_CREDS = { apiKey: "x", baseURL: "http://127.0.0.1:1/v1", model: "parent-model" };
const AGENT = (fm, body = "Do the thing.") => `---\n${fm}\n---\n${body}`;

async function repoWithAgent(file, content) {
  const repo = await makeRepo();
  const dir = path.join(repo, ".kodo", "agents");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, file), content);
  return repo;
}

function spawnCtx(root) {
  const fired = [];
  return {
    ctx: {
      root, emit: null, sessionId: "sess-x", requestId: "req-x",
      hooks: {}, permissions: { allow: [], ask: [], deny: [] },
      editedFiles: new Map(), readFiles: new Set(), todosRef: { current: [] },
      workspaceSnapshot: [], permissionMode: "auto", mcpClients: new Map(), mcpRoutes: new Map(),
      creds: DEAD_CREDS, isSubAgent: false,
      validToolNames: new Set(["read_file", "grep", "glob", "list_files", "bash", "write_file", "edit_file", "web_search", "fetch_url", "list_memory_topics", "read_memory_topic"]),
      fireHook: async (event, payload, opts = {}) => {
        fired.push({ event, payload });
        return fireHookEvent(event, payload, { config: normalizeHookConfig({}).hooks, cwd: root, ...opts });
      },
    },
    fired,
  };
}

await test("isolation: worktree spawns into a real worktree and cleans up after", async () => {
  const repo = await repoWithAgent("iso.md", AGENT("name: iso\ndescription: isolated\nisolation: worktree"));
  const { ctx, fired } = spawnCtx(repo);
  const before = activeWorktrees().length;
  const r = await executeTool("spawn_agent", { agent_type: "iso", prompt: "look" }, ctx);
  assert.strictEqual(r.success, true);
  assert.ok(r.worktree, "the run must report its worktree path");

  const start = fired.find((e) => e.event === "SubagentStart").payload;
  assert.strictEqual(start.isolation, "worktree");
  assert.ok(start.worktree_path, "hooks must carry the worktree path");
  assert.notStrictEqual(start.cwd, repo, "the subagent's cwd must be the worktree, not the parent");

  assert.strictEqual(activeWorktrees().length, before, "the worktree must be removed when the run ends");
  await assert.rejects(() => fs.access(r.worktree));
  await fs.rm(repo, { recursive: true, force: true });
});

await test("isolation on a NON-git workspace fails clearly and never runs unisolated", async () => {
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-plainws-"));
  await fs.mkdir(path.join(plain, ".kodo", "agents"), { recursive: true });
  await fs.writeFile(path.join(plain, ".kodo", "agents", "iso.md"), AGENT("name: iso\ndescription: d\nisolation: worktree"));
  const { ctx, fired } = spawnCtx(plain);
  const r = await executeTool("spawn_agent", { agent_type: "iso", prompt: "x" }, ctx);
  assert.strictEqual(r.success, false);
  assert.ok(/requires a git repository/.test(r.error));
  assert.strictEqual(fired.length, 0, "no lifecycle events for a run that never started");
  await fs.rm(plain, { recursive: true, force: true });
});

await test("background: true returns a task_id immediately without blocking", async () => {
  _resetBackgroundSubagents();
  const repo = await repoWithAgent("bg.md", AGENT("name: bg\ndescription: d\nbackground: true"));
  const { ctx } = spawnCtx(repo);
  const t0 = Date.now();
  const r = await executeTool("spawn_agent", { agent_type: "bg", prompt: "x" }, ctx);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.background, true);
  assert.ok(r.task_id, "must return a handle");
  assert.ok(Date.now() - t0 < 3000, "must return promptly rather than awaiting the subagent");

  await settle(300);
  const status = await executeTool("subagent_status", { task_id: r.task_id }, ctx);
  assert.strictEqual(status.success, true);
  assert.ok(["done", "error", "cancelled"].includes(status.status));
  await fs.rm(repo, { recursive: true, force: true });
});

await test("subagent_status lists this session's background tasks", async () => {
  _resetBackgroundSubagents();
  const repo = await repoWithAgent("bg.md", AGENT("name: bg\ndescription: d\nbackground: true"));
  const { ctx } = spawnCtx(repo);
  await executeTool("spawn_agent", { agent_type: "bg", prompt: "x" }, ctx);
  await settle(250);
  const list = await executeTool("subagent_status", {}, ctx);
  assert.strictEqual(list.tasks.length, 1);
  assert.strictEqual(list.tasks[0].agentType, "bg");
  assert.strictEqual((await executeTool("subagent_status", { task_id: "bg_nope" }, ctx)).success, false);
  await fs.rm(repo, { recursive: true, force: true });
});

await test("COMBINED: background + worktree runs isolated and cleans up the worktree", async () => {
  _resetBackgroundSubagents();
  const repo = await repoWithAgent("both.md", AGENT("name: both\ndescription: d\nbackground: true\nisolation: worktree"));
  const { ctx, fired } = spawnCtx(repo);
  const before = activeWorktrees().length;

  const r = await executeTool("spawn_agent", { agent_type: "both", prompt: "x" }, ctx);
  assert.strictEqual(r.background, true);
  assert.ok(r.worktree, "the worktree must exist while the background task runs");
  const worktreePath = r.worktree;
  await fs.access(worktreePath);

  await settle(400);
  const t = getBackgroundTask(r.task_id);
  assert.ok(["done", "error", "cancelled"].includes(t.status));
  assert.strictEqual(activeWorktrees().length, before, "the worktree must be cleaned up after the background task settles");
  await assert.rejects(() => fs.access(worktreePath), "the isolated dir must be gone");

  const start = fired.find((e) => e.event === "SubagentStart").payload;
  assert.strictEqual(start.background, true);
  assert.strictEqual(start.isolation, "worktree");
  await fs.access(path.join(repo, "app.js")); // parent intact
  await fs.rm(repo, { recursive: true, force: true });
});

await test("lifecycle events stay exactly-once for a background run", async () => {
  _resetBackgroundSubagents();
  const repo = await repoWithAgent("bg.md", AGENT("name: bg\ndescription: d\nbackground: true"));
  const { ctx, fired } = spawnCtx(repo);
  await executeTool("spawn_agent", { agent_type: "bg", prompt: "x" }, ctx);
  await settle(350);
  assert.strictEqual(fired.filter((e) => e.event === "SubagentStart").length, 1);
  assert.strictEqual(fired.filter((e) => e.event === "SubagentStop").length, 1);
  await fs.rm(repo, { recursive: true, force: true });
});

await test("the default explorer still runs foreground and creates no worktree", async () => {
  const repo = await makeRepo();
  const { ctx } = spawnCtx(repo);
  const before = activeWorktrees().length;
  const r = await executeTool("spawn_agent", { prompt: "investigate" }, ctx);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.background, undefined, "default must remain foreground");
  assert.strictEqual(r.worktree, null);
  assert.strictEqual(activeWorktrees().length, before);
  await fs.rm(repo, { recursive: true, force: true });
});

console.log("\n📦 registry + inspector");

await test("both fields parse and surface in the inspector", async () => {
  const d = parseAgentDefinition(AGENT("name: a\ndescription: d\nbackground: true\nisolation: worktree")).definition;
  assert.strictEqual(d.background, true);
  assert.strictEqual(d.isolation, "worktree");

  const repo = await repoWithAgent("a.md", AGENT("name: a\ndescription: d\nbackground: true\nisolation: worktree"));
  const { agents } = await loadSubagentRegistry(repo);
  const row = describeAgents(agents).find((x) => x.name === "a");
  assert.strictEqual(row.isolation, "worktree");
  assert.strictEqual(row.background, true);
  await fs.rm(repo, { recursive: true, force: true });
});

await removeAllWorktrees();
await shutdownBackgroundSubagents({ graceMs: 100 });

clearTimeout(watchdog);
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
