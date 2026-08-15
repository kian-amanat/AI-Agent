/**
 * tests/livePipeline.test.mjs
 * Run with: node tests/livePipeline.test.mjs
 *
 * LIVE PIPELINE PARITY
 *
 * Every other controller suite hand-builds the calls it feeds in. That is
 * useful and it is also exactly how a whole class of bug survives: the shapes
 * in the tests were the shapes I imagined, not the ones the tools emit.
 *
 * These drive the REAL path — `executeToolCallsBatch` against a real temp
 * workspace, real files, real shell exit codes — and assert on what the
 * controller concluded. Everything below the LLM is genuine; only the choice
 * of tool calls is scripted, because that is the model's job, not the
 * pipeline's.
 *
 * Bugs this suite exists to prevent, all of which passed the hand-built tests:
 *   - a green test run reporting "0 failed" was recorded as a FAILED check
 *   - `npm test 2>&1` was recorded as a workspace mutation
 *   - `list_files` earned no progress at all, because it takes `dir`, not `path`
 *   - a check that passed before three more edits still counted as "verified"
 */

import assert from "assert";
import { HostRuntime } from "../core/runtime/host.mjs";
import path from "path";
import os from "os";
import fs from "fs/promises";

import { createTaskController } from "../services/taskController.mjs";
import { executeToolCallsBatch } from "../agents/nodes/agent_loop.mjs";

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

/** A real workspace plus the real ctx the loop builds for its tools. */
async function workspace(task, files = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-live-"));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
  const controller = createTaskController({ task });
  const ctx = {
    root, emit: null, sessionId: "s", requestId: "r", hooks: {},
    runtime: new HostRuntime({ root }),
    editedFiles: new Map(), readFiles: new Set(), todosRef: { current: [] },
    workspaceSnapshot: [], permissionMode: "auto",
    taskController: controller,
  };
  let n = 0;
  /** Run tool calls exactly as the loop does, through the real dispatcher. */
  const call = async (...calls) => executeToolCallsBatch(
    calls.map((c) => ({ id: `c${++n}`, function: { name: c[0], arguments: JSON.stringify(c[1] ?? {}) } })),
    ctx, 1, 40, null,
  );
  const cleanup = () => fs.rm(root, { recursive: true, force: true });
  return { root, ctx, controller, call, cleanup };
}

const ok = (results, i = 0) => JSON.parse(results[i].content).success !== false;

console.log("\n══ real verification outcomes ════════════════════════════════");

await test("a shell command that PASSES while printing '0 failed' is recorded as passing", async () => {
  // The single most common line a green suite prints. A substring match on
  // /failed/ called it a failure, so a passing project could never finish.
  const w = await workspace("fix the parser in p.js", { "p.js": "module.exports = 1;\n" });
  await w.call(["read_file", { path: "p.js" }]);
  await w.call(["edit_file", { path: "p.js", old_string: "1", new_string: "2" }]);
  await w.call(["write_file", { path: "p.test.js", content: "console.log('26 passed, 0 failed');\n" }]);
  await w.call(["bash", { command: "node p.test.js" }]);

  const snap = w.controller.snapshot();
  assert.equal(snap.verificationRan, true, "the command was recognised as verification");
  assert.equal(snap.verificationPassed, true, `a zero-failure run must pass; got ${JSON.stringify(snap.verifications)}`);
  assert.equal(w.controller.canFinish({ editedPaths: w.ctx.editedFiles.keys() }).allowed, true);
  await w.cleanup();
});

await test("the exit code beats the words: exit 1 is a failure however cheerful the output", async () => {
  const w = await workspace("fix the parser in p.js", { "p.js": "module.exports = 1;\n" });
  await w.call(["read_file", { path: "p.js" }]);
  await w.call(["edit_file", { path: "p.js", old_string: "1", new_string: "2" }]);
  await w.call(["bash", { command: "npm test --prefix does-not-exist" }]);

  assert.equal(w.controller.snapshot().verificationPassed, false, "a non-zero exit is a failure");
  assert.equal(w.controller.canFinish({ editedPaths: w.ctx.editedFiles.keys() }).allowed, false);
  await w.cleanup();
});

await test("real compiler-style diagnostics on a failing run are still caught", async () => {
  const w = await workspace("fix the type error in p.ts", { "p.ts": "export const a = 1;\n" });
  await w.call(["read_file", { path: "p.ts" }]);
  await w.call(["edit_file", { path: "p.ts", old_string: "1", new_string: "2" }]);
  await w.call(["bash", { command: "npx --no-install tsc --noEmit p.ts" }]);
  assert.equal(w.controller.snapshot().verificationPassed, false);
  await w.cleanup();
});

console.log("\n══ real mutation accounting ══════════════════════════════════");

await test("running the tests is not implementing the feature", async () => {
  // `2>&1` and `> log` are punctuation on nearly every command. Counting them
  // as workspace changes let an action task finish without writing any code.
  const w = await workspace("add a dark mode toggle to the settings page");
  for (const command of ["npm test 2>&1", "npm test > out.log 2>&1", "ls -la 2>/dev/null"]) {
    await w.call(["bash", { command }]);
  }
  assert.equal(w.controller.snapshot().mutations, 0, "no code was written");
  const gate = w.controller.canFinish({ editedPaths: [], responseText: "Here it is:\n```tsx\nx\n```" });
  assert.equal(gate.allowed, false, "an action task must not finish on shell noise");
  assert.equal(gate.kind, "no_mutation");
  await w.cleanup();
});

await test("a shell command that really does write a file counts", async () => {
  const w = await workspace("add a config file");
  await w.call(["bash", { command: "echo 'export const a = 1;' > made.js" }]);
  assert.equal(w.controller.snapshot().mutations, 1);
  assert.equal((await fs.readFile(path.join(w.root, "made.js"), "utf8")).trim(), "export const a = 1;");
  await w.cleanup();
});

await test("write_file reports create vs edit, and integration follows that report", async () => {
  // Ground truth from the tool that stat'd the path — not inferred from what
  // the agent happened to read first.
  const w = await workspace("add a palette and wire it into the toolbar",
    { "toolbar.js": "export const items = [];\n" });
  await w.call(["write_file", { path: "Palette.js", content: "export const Palette = 1;\n" }]);
  assert.equal(w.controller.snapshot().integrationEdits, 0, "creating a file wires nothing up");

  await w.call(["read_file", { path: "toolbar.js" }]);
  await w.call(["write_file", { path: "toolbar.js", content: "export const items = [1];\n" }]);
  assert.equal(w.controller.snapshot().integrationEdits, 1, "overwriting an existing file IS integration");
  await w.cleanup();
});

await test("a real edit_file to an existing file counts as integration", async () => {
  const w = await workspace("wire the palette into the app", { "app.js": "const x = 1;\n" });
  await w.call(["read_file", { path: "app.js" }]);
  await w.call(["edit_file", { path: "app.js", old_string: "const x = 1;", new_string: "const x = 2;" }]);
  assert.equal(w.controller.snapshot().integrationEdits, 1);
  await w.cleanup();
});

await test("a REJECTED write is not a mutation and not a rewrite", async () => {
  // write_file refuses to clobber a file nobody read. That failure must not
  // register as a change, nor accumulate toward "you rewrote this file".
  const w = await workspace("update the config", { "cfg.js": "module.exports = {};\n" });
  const res = await w.call(["write_file", { path: "cfg.js", content: "module.exports = {a:1};\n" }]);
  assert.equal(ok(res), false, "the tool should refuse an unread overwrite");
  const snap = w.controller.snapshot();
  assert.equal(snap.mutations, 0, "a refused write changed nothing");
  assert.equal(snap.failures.length, 1, "…but it is remembered as a dead end");
  await w.cleanup();
});

console.log("\n══ real read accounting ══════════════════════════════════════");

await test("list_files earns progress — it takes `dir`, not `path`", async () => {
  // The bug: inspectionKey only looked at path/pattern/query/glob, so every
  // directory listing produced a null key and scored a dead turn.
  const w = await workspace("add pagination to the users list",
    { "app/users/page.js": "export default 1;\n", "app/lib/api.js": "export const get = 1;\n" });
  await w.call(["list_files", { dir: "app" }]);
  const v1 = w.controller.endIteration();
  assert.equal(v1.progressed, true, `listing a directory is discovery; reasons=${v1.reasons}`);

  await w.call(["list_files", { dir: "app/users" }]);
  assert.equal(w.controller.endIteration().progressed, true, "a different directory is a different question");

  await w.call(["list_files", { dir: "app/users" }]);
  assert.equal(w.controller.endIteration().progressed, false, "the identical listing teaches nothing");
  await w.cleanup();
});

await test("a read that fails with ENOENT still narrows the search", async () => {
  const w = await workspace("resume the partial palette");
  const res = await w.call(["read_file", { path: "src/CommandPalette.tsx" }]);
  assert.equal(ok(res), false, "the file genuinely is not there");
  assert.equal(w.controller.endIteration().progressed, true, "learning it is absent is discovery");
  await w.cleanup();
});

await test("real grep and glob register as distinct questions", async () => {
  const w = await workspace("add pagination", { "a.js": "registerCommand();\n", "b.js": "other();\n" });
  await w.call(["grep", { pattern: "registerCommand" }]);
  assert.equal(w.controller.endIteration().progressed, true);
  await w.call(["glob", { pattern: "*.js" }]);
  assert.equal(w.controller.endIteration().progressed, true);
  await w.call(["grep", { pattern: "registerCommand" }]);
  assert.equal(w.controller.endIteration().progressed, false, "the same grep twice teaches nothing");
  await w.cleanup();
});

console.log("\n══ verification honesty on the real path ═════════════════════");

await test("a check that passed BEFORE later edits does not certify the result", async () => {
  const w = await workspace("fix the parser in p.js", { "p.js": "module.exports = 1;\n" });
  await w.call(["read_file", { path: "p.js" }]);
  await w.call(["edit_file", { path: "p.js", old_string: "1", new_string: "2" }]);
  await w.call(["bash", { command: "node --check p.js" }]);
  assert.equal(w.controller.canFinish({ editedPaths: w.ctx.editedFiles.keys() }).allowed, true);

  // …now change the workspace again. The earlier pass is about a state that
  // no longer exists.
  await w.call(["write_file", { path: "q.js", content: "module.exports = 3;\n" }]);
  const gate = w.controller.canFinish({ editedPaths: w.ctx.editedFiles.keys() });
  assert.equal(gate.allowed, false, "a stale pass must not be reported as verified");
  assert.equal(gate.kind, "verification_stale");
  assert.match(gate.directive, /no longer exists|changed files since/i);
  await w.cleanup();
});

await test("re-running the check after the change clears it honestly", async () => {
  const w = await workspace("fix the parser in p.js", { "p.js": "module.exports = 1;\n" });
  await w.call(["read_file", { path: "p.js" }]);
  await w.call(["edit_file", { path: "p.js", old_string: "1", new_string: "2" }]);
  await w.call(["bash", { command: "node --check p.js" }]);
  await w.call(["write_file", { path: "q.js", content: "module.exports = 3;\n" }]);
  w.controller.canFinish({ editedPaths: w.ctx.editedFiles.keys() });   // stale pushback
  await w.call(["bash", { command: "node --check q.js" }]);

  const gate = w.controller.canFinish({ editedPaths: w.ctx.editedFiles.keys() });
  assert.equal(gate.allowed, true, gate.reason);
  assert.equal(gate.verified, true);
  await w.cleanup();
});

await test("a later FAILING run overrides an earlier pass", async () => {
  const w = await workspace("fix the parser in p.js", { "p.js": "module.exports = 1;\n" });
  await w.call(["read_file", { path: "p.js" }]);
  await w.call(["edit_file", { path: "p.js", old_string: "1", new_string: "2" }]);
  await w.call(["bash", { command: "node --check p.js" }]);
  await w.call(["bash", { command: "npm test --prefix does-not-exist" }]);
  const gate = w.controller.canFinish({ editedPaths: w.ctx.editedFiles.keys() });
  assert.equal(gate.allowed, false, "the most recent result is the one that counts");
  await w.cleanup();
});

console.log("\n══ real dead ends ════════════════════════════════════════════");

await test("a genuinely missing binary is named as the blocker", async () => {
  const w = await workspace("run the test suite and fix failures");
  let verdict = { stop: false };
  for (let i = 0; i < 8 && !verdict.stop; i++) {
    await w.call(["bash", { command: "kodo-nonexistent-binary --run" }]);
    verdict = w.controller.endIteration();
  }
  assert.equal(verdict.stop, true, "an impossible command must not be retried forever");
  assert.equal(verdict.reason, "blocked", `expected a named blocker, got ${verdict.reason}`);
  assert.match(w.controller.blockerReport(), /not found|blocked/i);
  await w.cleanup();
});

await test("a repeated failing edit against real tool errors is redirected then stopped", async () => {
  const w = await workspace("fix the greeting in a.js", { "a.js": "const hi = 1;\n" });
  await w.call(["read_file", { path: "a.js" }]);
  w.controller.endIteration();
  const directives = [];
  let verdict = { stop: false };
  for (let i = 0; i < 8 && !verdict.stop; i++) {
    // `old_string` is not in the file — the real tool rejects this every time.
    await w.call(["edit_file", { path: "a.js", old_string: "NOT_PRESENT", new_string: "x" }]);
    verdict = w.controller.endIteration();
    if (verdict.directive) directives.push(verdict.directive);
  }
  assert.ok(directives.some((d) => /write_file|re-read/i.test(d)), "must be pushed to a different approach");
  assert.equal(verdict.stop, true, "and eventually stopped");
  assert.equal((await fs.readFile(path.join(w.root, "a.js"), "utf8")).trim(), "const hi = 1;",
    "the file was never actually changed");
  await w.cleanup();
});

await test("a shell timeout is a blocker, not a mystery", async () => {
  const w = await workspace("run the integration suite");
  let verdict = { stop: false };
  for (let i = 0; i < 8 && !verdict.stop; i++) {
    await w.call(["bash", { command: "sleep 5", timeout: 1 }]);
    verdict = w.controller.endIteration();
  }
  assert.equal(verdict.stop, true, "a command that never completes must not be retried forever");
  await w.cleanup();
});

console.log("\n══ a complete, honest run ════════════════════════════════════");

await test("REPLAY: discover → plan → implement → wire → test → verify → finish", async () => {
  const w = await workspace("implement a command palette and wire it into the app with tests", {
    "app.js": "export const app = { commands: [] };\n",
    "package.json": '{"name":"x"}\n',
  });
  const step = async (...calls) => { await w.call(...calls); return w.controller.endIteration(); };

  let v = await step(["list_files", { dir: "." }]);
  assert.equal(v.stop, false);
  v = await step(["read_file", { path: "app.js" }]);
  assert.equal(v.stop, false);
  v = await step(["todo_write", { todos: [
    { content: "create palette.js", status: "pending" },
    { content: "wire it into app.js", status: "pending" },
    { content: "add tests", status: "pending" },
  ] }]);
  assert.equal(v.stop, false);

  // Only the first item is done — the run must not be allowed to finish here.
  await w.call(["write_file", { path: "palette.js", content: "export const palette = [];\n" }]);
  const early = w.controller.canFinish({ editedPaths: w.ctx.editedFiles.keys() });
  assert.equal(early.allowed, false, "one of three items is not done");
  assert.equal(early.kind, "open_plan_items");

  await w.call(["edit_file", { path: "app.js", old_string: "commands: []", new_string: "commands: [1]" }]);
  await w.call(["write_file", { path: "palette.test.js", content: "console.log('ok');\n" }]);
  await w.call(["todo_write", { todos: [
    { content: "create palette.js", status: "completed" },
    { content: "wire it into app.js", status: "completed" },
    { content: "add tests", status: "completed" },
  ] }]);
  await w.call(["bash", { command: "node --check palette.js && node palette.test.js" }]);

  const gate = w.controller.canFinish({ editedPaths: w.ctx.editedFiles.keys() });
  assert.equal(gate.allowed, true, `blocked: ${gate.reason}`);
  assert.equal(gate.verified, true);
  assert.ok(!gate.unmet, `nothing should be outstanding, got ${JSON.stringify(gate.unmet)}`);

  const snap = w.controller.snapshot();
  assert.equal(snap.verificationCurrent, true);
  assert.ok(snap.integrationEdits >= 1, "app.js was really modified");
  assert.equal(w.controller.stopReason, "verified");
  await w.cleanup();
});

await test("REPLAY: the same run WITHOUT the wiring or tests cannot claim success", async () => {
  const w = await workspace("implement a command palette and wire it into the app with tests", {
    "app.js": "export const app = { commands: [] };\n",
  });
  await w.call(["read_file", { path: "app.js" }]);
  await w.call(["write_file", { path: "palette.js", content: "export const palette = [];\n" }]);
  await w.call(["bash", { command: "node --check palette.js" }]);

  const gate = w.controller.canFinish({ editedPaths: w.ctx.editedFiles.keys() });
  assert.equal(gate.allowed, false, "a lone new file is not a wired, tested feature");
  assert.equal(gate.kind, "incomplete_shape");
  assert.match(gate.directive, /test file/i);
  assert.match(gate.directive, /not reachable|wired up/i);
  await w.cleanup();
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
