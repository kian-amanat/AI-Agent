/**
 * tests/agentBenchmark.test.mjs
 * Run with: node tests/agentBenchmark.test.mjs
 *
 * BEHAVIOURAL PARITY BENCHMARK
 *
 * The other suites test the controller's parts. This one tests the thing that
 * actually matters: given a realistic sequence of turns, does the run END the
 * way a competent coding agent's run would end?
 *
 * Each scenario replays a transcript shape observed from real tasks and asserts
 * on the OUTCOME — did it stop, when, with what reason, and was it allowed to
 * finish. Written this way because every regression so far has been a
 * whole-run behaviour ("it died on turn 3"), never a single wrong function.
 *
 * A scenario names the behaviour it protects, so a failure here says what a
 * user would have experienced, not which counter was off by one.
 */

import assert from "assert";
import { createTaskController } from "../services/taskController.mjs";

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

// ── turn builders ───────────────────────────────────────────────────────────
const read     = (p, extra = {}) => (c) => c.recordToolCall({ tool: "read_file", args: { path: p, ...extra }, ok: true });
const readFail = (p)             => (c) => c.recordToolCall({ tool: "read_file", args: { path: p }, ok: false, output: "ENOENT: no such file or directory" });
const grep     = (pattern, dir)  => (c) => c.recordToolCall({ tool: "grep", args: { pattern, dir }, ok: true });
const glob     = (g)             => (c) => c.recordToolCall({ tool: "glob", args: { glob: g }, ok: true });
const sh       = (command)       => (c) => c.recordToolCall({ tool: "bash", args: { command }, ok: true });
const plan     = (...items)      => (c) => c.recordToolCall({ tool: "todo_write", args: { todos: items }, ok: true });
const write    = (p)             => (c) => c.recordToolCall({ tool: "write_file", args: { path: p }, ok: true });
const edit     = (p)             => (c) => c.recordToolCall({ tool: "edit_file", args: { path: p }, ok: true });
const editFail = (p, err)        => (c) => c.recordToolCall({ tool: "edit_file", args: { path: p }, ok: false, output: err });
const verify   = (out = "")      => (c) => c.recordToolCall({ tool: "bash", args: { command: "npm run typecheck" }, ok: !out, output: out });

const todo = (content, status = "pending") => ({ content, status });
const TS_ERROR = "src/App.tsx(42,7): error TS2322: Type 'string' is not assignable to type 'number'.";

/** Replay turns until the controller stops. Returns the outcome. */
function run(task, turns, opts = {}) {
  const c = createTaskController({ task, ...opts });
  let verdict = { stop: false };
  let turnsRun = 0;
  const directives = [];
  for (const turn of turns) {
    turnsRun++;
    turn(c);
    verdict = c.endIteration();
    if (verdict.directive) directives.push(verdict.directive);
    if (verdict.stop) break;
  }
  return { c, verdict, turnsRun, directives, snapshot: c.snapshot() };
}

console.log("\n══ BENCHMARK: action request with partial implementation ═════");

await test("resuming half-built work survives the whole discovery pass", async () => {
  // The reported failure: the agent read App.tsx and friends, then died.
  const r = run("resume the partial command palette implementation", [
    glob("**/*Palette*"),
    readFail("src/CommandPalette.tsx"),
    sh("ls -R app/components"),
    read("app/components/CommandPalette.tsx"),
    read("app/App.tsx"),
    grep("registerCommand"),
    read("app/components/CommandPalette.tsx", { offset: 200 }),
    plan(todo("wire the shortcut"), todo("add handlers")),
  ]);
  assert.equal(r.verdict.stop, false, `died on turn ${r.turnsRun}: ${r.verdict.reason}`);
  assert.equal(r.c.requiresMutation, true, "'resume' is an action task");
});

await test("resuming cannot finish on a description alone", async () => {
  const r = run("resume the partial command palette implementation", [
    read("app/App.tsx"),
    read("app/components/CommandPalette.tsx"),
  ]);
  const gate = r.c.canFinish({ responseText: "Here's what remains:\n```tsx\nconst x = 1;\n```" });
  assert.equal(gate.allowed, false, "reading then describing is not resuming");
  assert.match(gate.directive, /did NOT create or edit any files|Implementation requested/);
});

console.log("\n══ BENCHMARK: question-only prompt ═══════════════════════════");

await test("a question finishes with no edits and no nagging", async () => {
  const r = run("Explain how the router picks a node", [
    read("agents/router.mjs"),
    read("agents/nodes/agent_loop.mjs"),
    grep("routeDecision"),
  ]);
  assert.equal(r.verdict.stop, false);
  assert.equal(r.c.requiresMutation, false, "a question must never demand a mutation");
  const gate = r.c.canFinish({ responseText: "The router scores the message and picks agent_loop when…" });
  assert.equal(gate.allowed, true, "an explanation is a complete answer");
});

await test("a question containing code fences still finishes", async () => {
  const r = run("What does this component do?", [read("app/Card.tsx")]);
  const gate = r.c.canFinish({ responseText: "It renders a card:\n```tsx\n<Card />\n```" });
  assert.equal(gate.allowed, true, "showing code in an answer is not an unfulfilled implementation");
});

console.log("\n══ BENCHMARK: polite imperative ══════════════════════════════");

await test("'Can you add a dark mode toggle?' is an instruction, not a question", async () => {
  const r = run("Can you add a dark mode toggle?", [read("app/theme.ts")]);
  assert.equal(r.c.requiresMutation, true);
  assert.equal(r.c.canFinish({ responseText: "Sure — here's how:\n```ts\n…\n```" }).allowed, false);
});

await test("'could you please finish the settings page' must mutate", async () => {
  const r = run("could you please finish the settings page", [read("app/settings/page.tsx")]);
  assert.equal(r.c.requiresMutation, true);
  assert.equal(r.c.canFinish({ responseText: "Done — the remaining code is above." }).allowed, false);
});

console.log("\n══ BENCHMARK: hard multi-file feature ════════════════════════");

await test("REQUIRED: the run does not end at the first edit", async () => {
  // The failure this protects: agent edits App.tsx, declares victory, leaves
  // the component unwritten and the tests unwritten.
  const r = run("implement a VS Code-style command palette", [
    read("app/App.tsx"),
    plan(todo("create Palette.tsx"), todo("wire the shortcut"), todo("add tests")),
    edit("app/App.tsx"),
  ]);
  const gate = r.c.canFinish({ editedPaths: ["app/App.tsx"] });
  assert.equal(gate.allowed, false, "one edit out of a three-item plan is not done");
  assert.match(gate.directive, /still open|not finished|remaining/i);
});

await test("REQUIRED: a multi-file feature completes when the plan is actually done", async () => {
  const r = run("implement a VS Code-style command palette", [
    read("app/App.tsx"),
    plan(todo("create Palette.tsx"), todo("wire the shortcut"), todo("add tests")),
    write("app/Palette.tsx"),
    edit("app/App.tsx"),
    write("app/Palette.test.ts"),
    plan(
      todo("create Palette.tsx", "completed"),
      todo("wire the shortcut", "completed"),
      todo("add tests", "completed"),
    ),
    verify(),
  ]);
  assert.equal(r.verdict.stop, false, `stopped early: ${r.verdict.reason}`);
  const gate = r.c.canFinish({ editedPaths: ["app/Palette.tsx", "app/App.tsx", "app/Palette.test.ts"] });
  assert.equal(gate.allowed, true, `blocked: ${gate.reason}`);
  assert.equal(gate.verified, true);
  assert.equal(r.c.stopReason, "verified");
});

console.log("\n══ BENCHMARK: repeated failing edit ══════════════════════════");

await test("REQUIRED: re-editing one file against the same error is thrashing", async () => {
  const r = run("Fix the type error in App.tsx", Array.from({ length: 12 }, () => (c) => {
    edit("src/App.tsx")(c);
    verify(TS_ERROR)(c);
  }));
  assert.equal(r.verdict.stop, true);
  assert.equal(r.verdict.reason, "thrashing");
  assert.ok(r.turnsRun <= 5, `burned ${r.turnsRun} turns before noticing`);
});

await test("REQUIRED: a repeated FAILING action is recognised and redirected", async () => {
  const r = run("Fix the build", [
    read("src/App.tsx"),
    editFail("src/App.tsx", "EACCES: permission denied"),
    editFail("src/App.tsx", "EACCES: permission denied"),
  ]);
  const warned = r.directives.some((d) => /already failed|different (approach|strategy)|EACCES/i.test(d));
  assert.ok(warned, `no recovery directive was issued; got: ${JSON.stringify(r.directives)}`);
});

console.log("\n══ BENCHMARK: repeated failing verification ══════════════════");

await test("REQUIRED: re-running the same failing check is not progress", async () => {
  const r = run("Fix the failing tests", [
    edit("src/a.ts"),
    verify(TS_ERROR),
    verify(TS_ERROR),
    verify(TS_ERROR),
    verify(TS_ERROR),
  ]);
  assert.equal(r.verdict.stop, true, "re-running a failing check forever must be caught");
  assert.ok(["blocked", "no_progress", "thrashing"].includes(r.verdict.reason), r.verdict.reason);
});

await test("REQUIRED: a failing verification blocks a success claim", async () => {
  const r = run("Fix the type error", [edit("src/App.tsx"), verify(TS_ERROR)]);
  const gate = r.c.canFinish({ editedPaths: ["src/App.tsx"] });
  assert.equal(gate.allowed, false);
  assert.notEqual(r.c.stopReason, "verified");
});

console.log("\n══ BENCHMARK: initial repository discovery ═══════════════════");

await test("REQUIRED: a long first discovery pass is never cut short", async () => {
  const r = run("add pagination to the users list", [
    glob("**/users/**"),
    read("app/users/page.tsx"),
    grep("useUsers"),
    read("app/hooks/useUsers.ts"),
    sh("cat package.json"),
    read("app/lib/api.ts"),
    readFail("app/users/Pagination.tsx"),
    grep("limit", "app"),
    read("app/components/Table.tsx"),
  ]);
  assert.equal(r.verdict.stop, false, `discovery cut off on turn ${r.turnsRun}`);
});

await test("REQUIRED: discovery does not continue forever", async () => {
  const r = run("add pagination to the users list",
    Array.from({ length: 40 }, (_, i) => read(`src/file${i}.ts`)));
  assert.equal(r.verdict.stop, true, "unbounded browsing must end");
  assert.ok(r.turnsRun < 20, `took ${r.turnsRun} turns`);
  assert.ok(r.directives.some((d) => /enough reading|commit/i.test(d)), "should be nudged before being stopped");
});

console.log("\n══ BENCHMARK: honest blockers ════════════════════════════════");

await test("REQUIRED: a missing tool is reported as a blocker, not as no_progress", async () => {
  const r = run("run the test suite and fix failures", [
    read("package.json"),
    (c) => c.recordToolCall({ tool: "bash", args: { command: "npm test" }, ok: false, output: "sh: vitest: command not found" }),
    (c) => c.recordToolCall({ tool: "bash", args: { command: "npx vitest run" }, ok: false, output: "sh: vitest: command not found" }),
    (c) => c.recordToolCall({ tool: "bash", args: { command: "npm test" }, ok: false, output: "sh: vitest: command not found" }),
    (c) => c.recordToolCall({ tool: "bash", args: { command: "npm test" }, ok: false, output: "sh: vitest: command not found" }),
  ]);
  assert.equal(r.verdict.stop, true);
  assert.equal(r.verdict.reason, "blocked", `a missing binary is a blocker, got ${r.verdict.reason}`);
  assert.match(r.c.blockerReport(), /command not found/i, "the report must name the real cause");
});

await test("the blocker report never dresses a failure up as success", async () => {
  const r = run("Fix the type error", Array.from({ length: 12 }, () => (c) => {
    edit("src/App.tsx")(c);
    verify(TS_ERROR)(c);
  }));
  const report = r.c.blockerReport();
  assert.match(report, /Stopped early/);
  assert.doesNotMatch(report, /✅|successfully completed|all done/i);
  assert.match(report, /src\/App\.tsx/, "names the file it was stuck on");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
