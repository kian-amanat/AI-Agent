/**
 * tests/toolScheduling.test.mjs
 * Run with: node tests/toolScheduling.test.mjs
 *
 * TOOL SCHEDULING AND TASK MEMORY
 *
 * Two properties that were real but unproven, and one that was missing.
 *
 *   1. Reads in one turn run CONCURRENTLY. This was already true and nothing
 *      tested it, so nothing would have noticed it silently regressing to
 *      serial — the kind of change that costs seconds per turn and shows up
 *      only as "kodo feels slow".
 *
 *   2. A write BLOCKS. Everything issued before it completes first, everything
 *      after starts only once it is done. Ordering of results is absolute.
 *
 *   3. Task memory stops the agent redoing work it already did.
 *
 * The concurrency tests measure real overlap rather than asserting on the
 * plan, because "the scheduler said parallel" and "the calls actually ran at
 * the same time" are different claims and only the second one matters.
 */

import assert from "assert";
import path from "path";
import os from "os";
import fs from "fs/promises";

import { createTaskController } from "../services/taskController.mjs";
import { executeToolCallsBatch, planToolBatch } from "../agents/nodes/agent_loop.mjs";

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

let seq = 0;
const mk = (name, args = {}) => ({
  id: `c${++seq}`,
  function: { name, arguments: JSON.stringify(args) },
});

async function workspace(files = {}, task = "audit the repo") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-sched-"));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
  const controller = createTaskController({ task });
  const ctx = {
    root, emit: null, sessionId: "s", requestId: "r", hooks: {},
    editedFiles: new Map(), readFiles: new Set(), todosRef: { current: [] },
    workspaceSnapshot: [], permissionMode: "auto", taskController: controller,
  };
  return { root, ctx, controller, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

/**
 * Watch real overlap by slowing every file read and recording how many were
 * in flight at once. Restores the original on the way out, always.
 */
async function withReadProbe(fn) {
  const original = fs.readFile;
  const probe = { max: 0, order: [] };
  let live = 0;
  fs.readFile = async (...a) => {
    live++;
    probe.max = Math.max(probe.max, live);
    probe.order.push(`start:${path.basename(String(a[0]))}`);
    await new Promise((r) => setTimeout(r, 25));
    try { return await original(...a); }
    finally { live--; probe.order.push(`end:${path.basename(String(a[0]))}`); }
  };
  try { await fn(probe); } finally { fs.readFile = original; }
}

const SIX = Object.fromEntries(
  Array.from({ length: 6 }, (_, i) => [`f${i}.js`, `export const a${i} = ${i};\n`.repeat(200)]),
);

console.log("\n══ parallel reads ════════════════════════════════════════════");

await test("independent reads in one turn really do overlap", async () => {
  const w = await workspace(SIX);
  await withReadProbe(async (probe) => {
    const started = Date.now();
    await executeToolCallsBatch(
      Array.from({ length: 6 }, (_, i) => mk("read_file", { path: `f${i}.js` })),
      w.ctx, 1, 40, null,
    );
    const elapsed = Date.now() - started;
    assert.ok(probe.max >= 6, `only ${probe.max} reads were ever in flight at once`);
    // Six 25ms reads: ~150ms serial, ~25ms concurrent. The bound is loose on
    // purpose — this asserts "not serial", not a performance number.
    assert.ok(elapsed < 120, `took ${elapsed}ms — that is serial execution`);
  });
  await w.cleanup();
});

await test("mixed read-only tools parallelize together, not just read_file", async () => {
  const w = await workspace(SIX);
  await withReadProbe(async (probe) => {
    await executeToolCallsBatch([
      mk("read_file", { path: "f0.js" }),
      mk("grep", { pattern: "export" }),
      mk("glob", { pattern: "*.js" }),
      mk("list_files", { dir: "." }),
      mk("read_file", { path: "f1.js" }),
    ], w.ctx, 1, 40, null);
    assert.ok(probe.max >= 2, "searches and reads should share a group");
  });
  await w.cleanup();
});

await test("results come back in the order they were issued, not the order they finished", async () => {
  const w = await workspace(SIX);
  const calls = Array.from({ length: 6 }, (_, i) => mk("read_file", { path: `f${i}.js` }));
  const results = await executeToolCallsBatch(calls, w.ctx, 1, 40, null);
  assert.deepEqual(results.map((r) => r.tool_call_id), calls.map((c) => c.id),
    "a tool result matched to the wrong call would corrupt the conversation");
  await w.cleanup();
});

console.log("\n══ blocked dependency ════════════════════════════════════════");

await test("a write blocks: nothing after it starts until it is done", async () => {
  const w = await workspace(SIX);
  await withReadProbe(async (probe) => {
    await executeToolCallsBatch([
      mk("read_file", { path: "f0.js" }),
      mk("read_file", { path: "f1.js" }),
      mk("write_file", { path: "new.js", content: "export const z = 1;\n" }),
      mk("read_file", { path: "f2.js" }),
      mk("read_file", { path: "f3.js" }),
    ], w.ctx, 1, 40, null);

    // Two groups of two, never four at once — the write is a barrier.
    assert.equal(probe.max, 2, `reads straddled the write (max in flight ${probe.max})`);
    const firstEnd = probe.order.indexOf("end:f1.js");
    const laterStart = probe.order.indexOf("start:f2.js");
    assert.ok(firstEnd < laterStart, "the pre-write reads must finish before the post-write reads begin");
  });
  await w.cleanup();
});

await test("a read issued after a write observes the written state", async () => {
  // The dependency that would actually corrupt a run if ordering slipped.
  const w = await workspace({ "a.js": "export const v = 1;\n" });
  const results = await executeToolCallsBatch([
    mk("read_file", { path: "a.js" }),
    mk("write_file", { path: "b.js", content: "export const v = 2;\n" }),
    mk("read_file", { path: "b.js" }),
  ], w.ctx, 1, 40, null);
  const third = JSON.parse(results[2].content);
  assert.equal(third.success !== false, true, `the post-write read failed: ${third.error}`);
  assert.match(third.content, /v = 2/, "the read must see what the write just produced");
  await w.cleanup();
});

await test("consecutive writes never overlap", async () => {
  const w = await workspace();
  const plan = planToolBatch([
    mk("write_file", { path: "a.js", content: "1" }),
    mk("write_file", { path: "b.js", content: "2" }),
    mk("edit_file", { path: "a.js", old_string: "1", new_string: "3" }),
  ]);
  assert.equal(plan.length, 3, "each write gets its own group");
  assert.ok(plan.every((g) => !g.parallel), "no write may share a group with anything");
  await w.cleanup();
});

console.log("\n══ the dependency analyzer ═══════════════════════════════════");

await test("reads group, writes separate, order is preserved end to end", async () => {
  const plan = planToolBatch([
    mk("read_file", { path: "a" }), mk("grep", { pattern: "x" }),
    mk("edit_file", { path: "a" }),
    mk("read_file", { path: "b" }), mk("glob", { pattern: "*" }),
    mk("bash", { command: "npm test" }),
  ]);
  assert.deepEqual(plan.map((g) => [g.parallel, g.calls.map((c) => c.index)]), [
    [true, [0, 1]],
    [false, [2]],
    [true, [3, 4]],
    [false, [5]],
  ]);
});

await test("side-effecting tools are never parallelized", async () => {
  for (const name of ["write_file", "edit_file", "bash", "todo_write", "spawn_agent", "ask_user", "review_patch"]) {
    const plan = planToolBatch([mk("read_file", { path: "a" }), mk(name, {}), mk("read_file", { path: "b" })]);
    assert.equal(plan.length, 3, `${name} must break the batch`);
    assert.equal(plan[1].parallel, false, `${name} must never run concurrently`);
  }
});

await test("the analyzer is total — malformed arguments do not break scheduling", async () => {
  const plan = planToolBatch([
    { id: "a", function: { name: "read_file", arguments: "{not json" } },
    { id: "b", function: { name: "read_file" } },
    {},
  ]);
  assert.equal(plan.length, 2, "two reads group, the shapeless call is sequential");
  assert.deepEqual(plan[0].calls.map((c) => c.args), [{}, {}], "unparseable arguments degrade to {}");
});

await test("an empty or absent batch plans to nothing", async () => {
  assert.deepEqual(planToolBatch([]), []);
  assert.deepEqual(planToolBatch(undefined), []);
});

console.log("\n══ memory prevents duplicate work ════════════════════════════");

await test("re-reading an unchanged file returns a pointer, not the file again", async () => {
  const big = "export const x = 1;\n".repeat(120);
  const w = await workspace({ "big.js": big });

  const first = await executeToolCallsBatch([mk("read_file", { path: "big.js" })], w.ctx, 1, 40, null);
  const a = JSON.parse(first[0].content);
  assert.match(a.content, /export const x/, "the first read returns the file");

  const second = await executeToolCallsBatch([mk("read_file", { path: "big.js" })], w.ctx, 1, 40, null);
  const b = JSON.parse(second[0].content);
  assert.equal(b.unchanged, true, "the second read must be recognised as duplicate work");
  assert.equal(b.content, undefined, "and must not spend the whole file again");
  assert.match(b.note, /already read/i);
  assert.ok(second[0].content.length < first[0].content.length / 10, "the saving must be real");
  await w.cleanup();
});

await test("a TRUNCATED read is never remembered as fully delivered", async () => {
  // The controller sees the whole file; the model only received the first
  // slice of it. Remembering that as "delivered" would answer a later read
  // with "you already have this" about content it had never seen.
  const w = await workspace({ "huge.js": "export const x = 1;\n".repeat(4000) });
  const first = await executeToolCallsBatch([mk("read_file", { path: "huge.js" })], w.ctx, 1, 40, null);
  assert.ok(first[0].content.includes("[truncated]"), "this file must be big enough to truncate");

  const second = await executeToolCallsBatch([mk("read_file", { path: "huge.js" })], w.ctx, 1, 40, null);
  assert.ok(!second[0].content.includes('"unchanged":true'),
    "a truncated read must be repeated in full, not replaced by a pointer");
  await w.cleanup();
});

await test("a file that CHANGED is always returned in full", async () => {
  // The optimisation proves the content is identical rather than assuming it,
  // so a user editing the file in their own editor mid-run is safe.
  const w = await workspace({ "a.js": "export const v = 1;\n" });
  await executeToolCallsBatch([mk("read_file", { path: "a.js" })], w.ctx, 1, 40, null);

  await fs.writeFile(path.join(w.root, "a.js"), "export const v = 999;\n");   // changed outside kodo
  const again = await executeToolCallsBatch([mk("read_file", { path: "a.js" })], w.ctx, 1, 40, null);
  const r = JSON.parse(again[0].content);
  assert.notEqual(r.unchanged, true, "changed content must never be suppressed");
  assert.match(r.content, /v = 999/, "the model must see the new content");
  await w.cleanup();
});

await test("a file kodo itself edited is re-read in full", async () => {
  const w = await workspace({ "a.js": "export const v = 1;\n" });
  await executeToolCallsBatch([mk("read_file", { path: "a.js" })], w.ctx, 1, 40, null);
  await executeToolCallsBatch([mk("edit_file", { path: "a.js", old_string: "1", new_string: "2" })], w.ctx, 1, 40, null);
  const again = await executeToolCallsBatch([mk("read_file", { path: "a.js" })], w.ctx, 1, 40, null);
  const r = JSON.parse(again[0].content);
  assert.match(r.content, /v = 2/, "after its own edit the agent must see the result");
  await w.cleanup();
});

await test("a partial read is never mistaken for the whole file", async () => {
  const w = await workspace({ "big.js": "export const x = 1;\n".repeat(500) });
  await executeToolCallsBatch([mk("read_file", { path: "big.js" })], w.ctx, 1, 40, null);
  assert.equal(w.controller.recall("read_file", { path: "big.js", offset: 200 }), null,
    "a different window of the file is a different question");
  await w.cleanup();
});

console.log("\n══ the task memory itself ════════════════════════════════════");

await test("memory records explored files, failed approaches and successful fixes", async () => {
  const w = await workspace({ "a.js": "export const v = 1;\n" });
  // A failure, then the recovery that made it work.
  await executeToolCallsBatch([mk("edit_file", { path: "a.js", old_string: "NOPE", new_string: "x" })], w.ctx, 1, 40, null);
  await executeToolCallsBatch([mk("read_file", { path: "a.js" })], w.ctx, 1, 40, null);
  await executeToolCallsBatch([mk("edit_file", { path: "a.js", old_string: "v = 1", new_string: "v = 2" })], w.ctx, 1, 40, null);

  const mem = w.controller.memory();
  assert.ok(mem.explored.some((e) => e.path === "a.js"), "explored files are remembered");
  assert.ok(mem.failed.some((f) => f.tool === "edit_file"), "failed approaches are remembered");
  assert.ok(mem.fixed.some((f) => f.tool === "edit_file" && f.target === "a.js"),
    `the fix that worked must be remembered; got ${JSON.stringify(mem.fixed)}`);
  await w.cleanup();
});

await test("a stopped run reports what DID work, not only what failed", async () => {
  const c = createTaskController({ task: "fix the parser in p.js" });
  c.recordToolCall({ tool: "read_file", args: { path: "p.js" }, ok: false, output: "ENOENT: no such file" });
  c.recordToolCall({ tool: "read_file", args: { path: "p.js" }, ok: true, output: '{"success":true}' });
  let v = { stop: false };
  for (let i = 0; i < 30 && !v.stop; i++) {
    c.recordToolCall({ tool: "edit_file", args: { path: "p.js" }, ok: true });
    c.recordToolCall({ tool: "bash", args: { command: "npm test" }, ok: false, output: "1 failed" });
    v = c.endIteration();
  }
  const report = c.blockerReport();
  assert.match(report, /What did work/, "a stopped run still learned something worth keeping");
  assert.match(report, /read_file/);
});

await test("memory is task-lifetime only — two tasks share nothing", async () => {
  const a = createTaskController({ task: "fix a.js" });
  a.recordToolCall({ tool: "read_file", args: { path: "a.js" }, ok: true, output: "x" });
  a.rememberRead("a.js", "hello");
  assert.ok(a.recallRead("a.js", "hello"), "within the task, memory holds");

  const b = createTaskController({ task: "fix a.js" });
  assert.equal(b.recallRead("a.js", "hello"), null, "a new task starts with no memory at all");
  assert.equal(b.memory().explored.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
