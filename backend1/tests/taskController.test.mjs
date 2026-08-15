/**
 * tests/taskController.test.mjs
 * Run with: node tests/taskController.test.mjs
 *
 * The agent's task state machine: inspect → plan → patch → verify → finish.
 *
 * The two properties that matter, and that this file exists to prove:
 *   1. Repeated thrashing on one file forces a re-plan (and then a strategy switch).
 *   2. A run that edited files cannot finish until verification has actually run.
 *
 * The controller is pure, so these drive it with real call sequences — the
 * same shape runAndFormatToolCall feeds it in production.
 */

import assert from "assert";
import { HostRuntime } from "../core/runtime/host.mjs";
import path from "path";
import os from "os";
import fs from "fs/promises";

import {
  createTaskController, fixSignature, extractErrorSignature, detectActionIntent,
  inspectionKey, failureSignature, looksMultiStep, STATES, PHASES,
} from "../services/taskController.mjs";
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

// Convenience wrappers mirroring how the loop reports calls.
const edit = (c, p) => c.recordToolCall({ tool: "edit_file", args: { path: p }, ok: true });
const typecheck = (c, output) =>
  c.recordToolCall({
    tool: "bash",
    args: { command: "npm run typecheck" },
    ok: !output,
    output: output || "no errors",
  });

const TS_ERROR = "src/Button.tsx(14,3): error TS2322: Type 'string' is not assignable to type 'number'.";

console.log("\n── task state machine ───────────────────────────────────────");

await test("a read-only run finishes freely — nothing was edited", async () => {
  const c = createTaskController();
  c.recordToolCall({ tool: "read_file", args: { path: "a.ts" }, ok: true });
  c.recordToolCall({ tool: "grep", args: { pattern: "foo" }, ok: true });
  const gate = c.canFinish();
  assert.ok(gate.allowed, "a question/investigation must not be gated");
  assert.match(gate.reason, /no edits/);
});

await test("the machine advances forwards through its states and never regresses", async () => {
  const c = createTaskController();
  assert.equal(c.state, "inspect");
  c.recordToolCall({ tool: "todo_write", args: {}, ok: true });
  assert.equal(c.state, "plan");
  edit(c, "src/a.ts");
  assert.equal(c.state, "patch");
  typecheck(c);
  assert.equal(c.state, "verify");
  // A later read must not drag it back to `inspect`.
  c.recordToolCall({ tool: "read_file", args: { path: "src/a.ts" }, ok: true });
  assert.equal(c.state, "verify");
  assert.ok(c.canFinish().allowed);
  assert.equal(c.state, "finish");
  assert.ok(STATES.includes(c.state));
});

console.log("\n── the verification gate ────────────────────────────────────");

await test("REQUIRED: edited files cannot finish until verification has run", async () => {
  const c = createTaskController();
  edit(c, "src/server.ts");

  const first = c.canFinish();
  assert.equal(first.allowed, false, "finishing on unverified edits must be refused");
  assert.match(first.reason, /no verification/);
  assert.match(first.directive, /have not verified/i);
  assert.match(first.directive, /src\/server\.ts/, "the directive names what was edited");

  // The agent complies and runs a real check.
  typecheck(c);
  const after = c.canFinish();
  assert.equal(after.allowed, true, "once verification passes, finishing is allowed");
  assert.equal(after.verified, true);
});

await test("a failing verification keeps the run going instead of claiming success", async () => {
  const c = createTaskController();
  edit(c, "src/Button.tsx");
  typecheck(c, TS_ERROR);
  const gate = c.canFinish();
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /failed/);
  assert.match(gate.directive, /still failing/i);
});

await test("the gate is bounded — an unverifiable project still terminates, flagged honestly", async () => {
  const c = createTaskController();
  edit(c, "src/a.ts");
  assert.equal(c.canFinish().allowed, false);
  assert.equal(c.canFinish().allowed, false);
  const third = c.canFinish();
  assert.equal(third.allowed, true, "must not trap the agent in an unwinnable loop");
  assert.equal(third.unverified, true, "but it is reported as unverified, not as success");
});

await test("a non-verification bash command does not satisfy the gate", async () => {
  const c = createTaskController();
  edit(c, "src/a.ts");
  c.recordToolCall({ tool: "bash", args: { command: "ls -la src" }, ok: true });
  const gate = c.canFinish();
  assert.equal(gate.allowed, false, "`ls` is not verification");
  assert.match(gate.reason, /no verification/);
});

await test("the caller's edit set is authoritative — tools without a path arg still gate", async () => {
  const c = createTaskController();
  // apply_patch changed files, but carries no `path` argument, so the
  // controller's own inference sees nothing.
  c.recordToolCall({ tool: "apply_patch", args: {}, ok: true });
  assert.equal(c.canFinish().allowed, true, "inference alone finds no edits");

  const withReal = createTaskController();
  withReal.recordToolCall({ tool: "apply_patch", args: {}, ok: true });
  const gate = withReal.canFinish({ editedPaths: ["src/server.ts", "src/db.ts"] });
  assert.equal(gate.allowed, false, "the loop's real edit set must trigger the gate");
  assert.match(gate.directive, /src\/db\.ts/);
});

await test("a project stop hook counts as verification", async () => {
  const c = createTaskController();
  edit(c, "src/a.ts");
  c.recordVerification({ command: "npm test", passed: true });
  assert.equal(c.canFinish().allowed, true);
});

console.log("\n── repetition detection ─────────────────────────────────────");

await test("REQUIRED: repeated thrashing on one file forces a re-plan", async () => {
  const c = createTaskController();

  // The classic TSX churn: edit, same error, edit, same error, edit.
  edit(c, "src/Button.tsx");
  typecheck(c, TS_ERROR);
  assert.equal(c.detectThrash(), null, "one retry is not yet thrashing");

  edit(c, "src/Button.tsx");
  typecheck(c, TS_ERROR);
  edit(c, "src/Button.tsx");
  typecheck(c, TS_ERROR);

  const event = c.detectThrash();
  assert.ok(event, "three same-file edits against an unchanging error is thrashing");
  assert.equal(event.signature, "edit_file:src/Button.tsx");
  assert.equal(event.count, 3);

  const directive = c.strategyDirective(event);
  assert.match(directive, /STOP repeating this fix/);
  assert.match(directive, /RE-PLAN/, "the first escalation is to re-plan, not to rewrite");
  assert.match(directive, /src\/Button\.tsx/);
});

await test("the same stuck path is reported once, not on every subsequent turn", async () => {
  const c = createTaskController();
  for (let i = 0; i < 3; i++) { edit(c, "src/a.ts"); typecheck(c, TS_ERROR); }
  assert.ok(c.detectThrash(), "fires once");
  assert.equal(c.detectThrash(), null, "does not re-fire for the same attempt count");
});

await test("productive repetition is not thrashing — the error changed", async () => {
  const c = createTaskController();
  edit(c, "src/a.ts");
  typecheck(c, "error TS2322: Type 'string' is not assignable to type 'number'.");
  edit(c, "src/a.ts");
  typecheck(c, "error TS2304: Cannot find name 'foo'.");
  edit(c, "src/a.ts");
  typecheck(c, "error TS7006: Property 'bar' does not exist on type 'Baz'.");
  assert.equal(c.detectThrash(), null, "each edit surfaced a different failure — that is progress");
});

await test("repetition that ends in a passing check is not thrashing", async () => {
  const c = createTaskController();
  edit(c, "src/a.ts");
  typecheck(c, TS_ERROR);
  edit(c, "src/a.ts");
  typecheck(c, TS_ERROR);
  edit(c, "src/a.ts");
  typecheck(c); // passes
  assert.equal(c.detectThrash(), null, "it got there in the end");
});

await test("edits spread across different files are not thrashing", async () => {
  const c = createTaskController();
  edit(c, "src/a.ts");
  edit(c, "src/b.ts");
  edit(c, "src/c.ts");
  typecheck(c, TS_ERROR);
  assert.equal(c.detectThrash(), null, "a multi-file change is normal work");
});

console.log("\n── fallback strategy switch ─────────────────────────────────");

await test("staying stuck escalates from re-planning to a structural rewrite", async () => {
  const c = createTaskController();
  assert.equal(c.strategy, 1);

  for (let i = 0; i < 3; i++) { edit(c, "src/a.ts"); typecheck(c, TS_ERROR); }
  const first = c.detectThrash();
  c.escalateStrategy();
  assert.match(c.strategyDirective(first), /RE-PLAN/);

  // Still stuck after the re-plan.
  for (let i = 0; i < 2; i++) { edit(c, "src/a.ts"); typecheck(c, TS_ERROR); }
  const second = c.detectThrash();
  assert.ok(second, "a second stuck round is detected");
  c.escalateStrategy();
  const directive = c.strategyDirective(second);
  assert.match(directive, /SIMPLER, more STRUCTURAL/);
  assert.match(directive, /write_file/, "it is told to rewrite the unit rather than keep patching lines");
  assert.ok(c.strategy > 2);
});

await test("strategy escalation is bounded", async () => {
  const c = createTaskController({ maxStrategy: 3 });
  for (let i = 0; i < 10; i++) c.escalateStrategy();
  assert.ok(c.strategy <= 4, `strategy runaway: ${c.strategy}`);
});

console.log("\n── signatures ───────────────────────────────────────────────");

await test("the fix signature is tool + target", async () => {
  assert.equal(fixSignature("edit_file", { path: "a.ts" }), "edit_file:a.ts");
  assert.notEqual(
    fixSignature("edit_file", { path: "a.ts" }),
    fixSignature("write_file", { path: "a.ts" }),
  );
});

await test("the inspection key separates new information from a repeat look", async () => {
  const same = inspectionKey("read_file", { path: "a.ts" });
  assert.equal(inspectionKey("read_file", { path: "a.ts" }), same, "an identical read is not new");
  assert.notEqual(inspectionKey("read_file", { path: "a.ts", offset: 200 }), same, "a different slice is new");
  assert.notEqual(inspectionKey("grep", { pattern: "x", dir: "src" }),
                  inspectionKey("grep", { pattern: "x", dir: "app" }), "a different scope is a different question");
  assert.equal(inspectionKey("read_file", {}), null, "a call with no target is not an inspection");
});

await test("error signatures are order-independent and ignore noise", async () => {
  const a = extractErrorSignature("error TS2322 here\nCannot find name 'x'");
  const b = extractErrorSignature("Cannot find name 'y'\nerror TS2322 there");
  assert.equal(a, b, "the same class of diagnostics compares equal");
  assert.equal(extractErrorSignature("Build succeeded in 3.2s"), null);
  assert.equal(extractErrorSignature(""), null);
});

console.log("\n── execution intent detection ───────────────────────────────");

await test("implementation requests are recognised as requiring a mutation", async () => {
  for (const req of [
    "Add a loading skeleton component.",
    "Create a new component",
    "Fix this bug",
    "implement pagination on the users list",
    "refactor the auth middleware",
    "update the README badge",
    "remove the deprecated endpoint",
    "migrate the config to TypeScript",
    "Can you add a dark mode toggle?",
    "please install zod and wire it into the form",
    // Picking up half-finished work is an instruction to change the repo too.
    "resume the partial command palette implementation",
    "continue where you left off on the modal",
    "finish the half-built settings page",
    "complete the migration",
  ]) {
    assert.equal(detectActionIntent(req), true, `should require mutation: "${req}"`);
  }
});

await test("questions and explanations do not require a mutation", async () => {
  for (const req of [
    "Explain this component",
    "What does this function do?",
    "Why is this test failing?",
    "How do I add a loading skeleton?",
    "walk me through the auth flow",
    "review the changes in this file",
    "describe how the router picks a node",
    "just show me the code for a skeleton",
    "give me an example of a skeleton component",
    "how would you refactor this?",
    "Show me the code without editing anything",
    // Modal questions about the work, not instructions to do it. The cost of
    // getting these wrong is a real question trapped in an execution loop.
    "should I continue using zod here?",
    "can we finish this later?",
    "is this refactor safe?",
  ]) {
    assert.equal(detectActionIntent(req), false, `should NOT require mutation: "${req}"`);
  }
});

await test("an explicit opt-out beats an action verb sitting next to it", async () => {
  assert.equal(detectActionIntent("add a skeleton — but don't edit any files, just show me"), false);
  assert.equal(detectActionIntent("explain how you would implement caching"), false);
});

await test("an empty or contentless task requires nothing", async () => {
  assert.equal(detectActionIntent(""), false);
  assert.equal(detectActionIntent(null), false);
  assert.equal(detectActionIntent("   "), false);
});

console.log("\n── execution intent enforcement ─────────────────────────────");

await test("CASE 1: 'Create a new component' cannot finish without a file mutation", async () => {
  const c = createTaskController({ task: "Create a new component" });
  assert.equal(c.requiresMutation, true);

  // The agent reads the repo and writes the component into the chat instead.
  c.recordToolCall({ tool: "list_files", args: { path: "app/components" }, ok: true });
  c.recordToolCall({ tool: "read_file", args: { path: "app/components/Button.tsx" }, ok: true });

  const gate = c.canFinish({ responseText: "Here's the component:\n```tsx\nexport function Skeleton() {}\n```" });
  assert.equal(gate.allowed, false, "describing the component is not creating it");
  assert.match(gate.directive, /did NOT create or edit any files/);
  assert.match(gate.directive, /write_file/);

  // Once it actually writes the file, the intent gate is satisfied.
  c.recordToolCall({ tool: "write_file", args: { path: "app/components/Skeleton.tsx" }, ok: true });
  const after = c.canFinish({ responseText: "Done." });
  assert.doesNotMatch(String(after.reason), /nothing was modified/, "the intent gate is satisfied");
});

await test("CASE 2: 'Explain this component' can answer with no mutation at all", async () => {
  const c = createTaskController({ task: "Explain this component" });
  assert.equal(c.requiresMutation, false);

  c.recordToolCall({ tool: "read_file", args: { path: "app/components/Button.tsx" }, ok: true });

  const gate = c.canFinish({ responseText: "This component renders a button and…" });
  assert.equal(gate.allowed, true, "a question must never be forced to edit files");
  assert.match(gate.reason, /no edits/);
});

await test("CASE 3: 'Fix this bug' must modify files before it can succeed", async () => {
  const c = createTaskController({ task: "Fix this bug in the date parser" });
  assert.equal(c.requiresMutation, true);

  c.recordToolCall({ tool: "grep", args: { pattern: "parseDate" }, ok: true });
  c.recordToolCall({ tool: "read_file", args: { path: "src/date.ts" }, ok: true });

  const first = c.canFinish({ responseText: "The bug is on line 42 — the month is zero-indexed." });
  assert.equal(first.allowed, false, "diagnosing is not fixing");
  assert.match(first.directive, /Implementation requested/);
  assert.match(first.directive, /did not modify files/);
  assert.match(first.directive, /Continue by applying the changes/);

  // It applies the fix — but now the VERIFY gate takes over.
  c.recordToolCall({ tool: "edit_file", args: { path: "src/date.ts" }, ok: true });
  const second = c.canFinish({ responseText: "Fixed." });
  assert.equal(second.allowed, false, "an unverified fix is still not a success");
  assert.match(second.reason, /no verification/);

  typecheck(c);
  const third = c.canFinish({ responseText: "Fixed and verified." });
  assert.equal(third.allowed, true);
  assert.equal(third.verified, true);
});

await test("the prose-only bail-out is caught too, not just fenced code blocks", async () => {
  // The original failure mode only checked for ``` blocks, so a purely
  // narrative "here's what I would do" slipped straight through to finish.
  const c = createTaskController({ task: "Add a loading skeleton component." });
  c.recordToolCall({ tool: "read_file", args: { path: "app/page.tsx" }, ok: true });

  const gate = c.canFinish({ responseText: "You should create a Skeleton component in app/components and import it into the page." });
  assert.equal(gate.allowed, false, "no code fence, but still just a description");
  assert.match(gate.directive, /Implementation requested/);
});

await test("the gate does not relent after one pushback", async () => {
  // The old enforcedApply fired exactly once; a second bail-out finished.
  const c = createTaskController({ task: "Add a skeleton component" });
  assert.equal(c.canFinish({ responseText: "```tsx\ncode\n```" }).allowed, false);
  assert.equal(c.canFinish({ responseText: "```tsx\ncode again\n```" }).allowed, false,
    "a second description must be rejected too");
});

await test("a shell command that changes files counts as a real mutation", async () => {
  const c = createTaskController({ task: "create the migrations directory and scaffold a migration" });
  c.recordToolCall({ tool: "bash", args: { command: "mkdir -p db/migrations && touch db/migrations/001.sql" }, ok: true });
  assert.equal(c.mutations, 1);
  const gate = c.canFinish({ responseText: "Created." });
  assert.doesNotMatch(String(gate.reason), /nothing was modified/, "shell mutations satisfy the intent gate");
});

await test("a read-only shell command does not count as a mutation", async () => {
  const c = createTaskController({ task: "add a config file" });
  c.recordToolCall({ tool: "bash", args: { command: "ls -la && cat package.json" }, ok: true });
  assert.equal(c.mutations, 0);
  assert.equal(c.canFinish({ responseText: "Here's what I found." }).allowed, false);
});

await test("a FAILED write does not satisfy the intent gate", async () => {
  const c = createTaskController({ task: "create a Skeleton component" });
  c.recordToolCall({ tool: "write_file", args: { path: "a.tsx" }, ok: false, output: "EACCES: permission denied" });
  assert.equal(c.mutations, 0, "a write that errored changed nothing");
  assert.equal(c.canFinish({ responseText: "Created it." }).allowed, false);
});

await test("apply_patch satisfies the intent gate despite carrying no path", async () => {
  const c = createTaskController({ task: "apply the refactor" });
  c.recordToolCall({ tool: "apply_patch", args: {}, ok: true });
  assert.equal(c.mutations, 1);
  assert.doesNotMatch(String(c.canFinish({ responseText: "Applied." }).reason), /nothing was modified/);
});

await test("an agent that refuses to ever mutate ends honestly, not in a loop", async () => {
  const c = createTaskController({ task: "Add a skeleton component" });
  let gate;
  for (let i = 0; i < 6; i++) gate = c.canFinish({ responseText: "Here is the code you need." });
  assert.equal(gate.allowed, true, "must terminate rather than spin forever");
  assert.equal(gate.unfulfilled, true, "but flagged as NOT delivered");
  assert.equal(c.stopReason, "blocked");
  assert.notEqual(c.stopReason, "verified");
});

console.log("\n── phase-aware progress ─────────────────────────────────────");

// Reading is the work during discovery and merely support work later, so these
// drive whole turn SEQUENCES rather than single calls — the misbehaviour only
// appears across several turns.
const read = (c, p, extra = {}) => c.recordToolCall({ tool: "read_file", args: { path: p, ...extra }, ok: true });
const grep = (c, pattern, dir) => c.recordToolCall({ tool: "grep", args: { pattern, dir }, ok: true });
const plan = (c, todos) => c.recordToolCall({ tool: "todo_write", args: { todos }, ok: true });

/** Run turns until a stop; returns the verdict and the turn it happened on. */
function drive(c, turns) {
  let verdict = { stop: false };
  let i = 0;
  for (const turn of turns) {
    i++;
    turn(c);
    verdict = c.endIteration();
    if (verdict.stop) break;
  }
  return { verdict, turnsRun: i };
}

await test("REQUIRED: an agent can inspect several files before editing", async () => {
  const c = createTaskController({ task: "Add a command palette entry" });
  const { verdict, turnsRun } = drive(c, [
    (x) => read(x, "app/components/CommandPalette.tsx"),
    (x) => read(x, "app/App.tsx"),
    (x) => read(x, "app/hooks/useCommands.ts"),
    (x) => grep(x, "registerCommand"),
    (x) => read(x, "app/lib/commands.ts"),
    (x) => read(x, "app/types.ts"),
  ]);
  assert.equal(verdict.stop, false, `exploration was cut off at turn ${turnsRun}`);
  assert.equal(verdict.phase, "DISCOVERY");
  assert.equal(c.snapshot().discoveryTurns, 6);
});

await test("REQUIRED: re-reading the same file with no new information is no_progress", async () => {
  const c = createTaskController({ task: "Add a command palette entry" });
  const { verdict, turnsRun } = drive(c, Array.from({ length: 12 }, () => (x) => read(x, "app/App.tsx")));
  assert.equal(verdict.stop, true, "an identical read repeated forever must be caught");
  assert.equal(verdict.reason, "no_progress");
  // It costs a few extra turns now, because the first stall buys a directive
  // rather than a stop. That is the point — but it must stay cheap.
  assert.ok(turnsRun <= 8, `took ${turnsRun} turns to catch an identical read`);
  assert.equal(c.snapshot().discoveryGraceUsed, true, "the reprieve should have fired first");
});

await test("the first-pass reprieve nudges instead of killing, and is granted only once", async () => {
  const c = createTaskController({ task: "resume the partial command palette implementation" });
  const nudged = drive(c, [
    (x) => read(x, "app/App.tsx"),
    (x) => read(x, "app/App.tsx"),
    (x) => read(x, "app/App.tsx"),
    (x) => read(x, "app/App.tsx"),
  ]);
  assert.equal(nudged.verdict.stop, false, "the first stall must not end the task");
  assert.match(nudged.verdict.directive, /not learning anything new/);
  assert.match(nudged.verdict.directive, /write_file/, "an action task is pointed at making the change");
  assert.equal(nudged.verdict.noProgressStreak, 0, "the streak restarts after the nudge");

  // Second stall: no second reprieve.
  const after = drive(c, Array.from({ length: 4 }, () => (x) => read(x, "app/App.tsx")));
  assert.equal(after.verdict.stop, true);
  assert.equal(after.verdict.reason, "no_progress");
});

await test("an action task that only ever explored says exactly that", async () => {
  const c = createTaskController({ task: "Add a loading skeleton component" });
  drive(c, Array.from({ length: 12 }, () => (x) => read(x, "app/App.tsx")));
  assert.equal(c.stopReason, "no_progress");
  assert.match(c.blockerReport(), /without making any change to the workspace/);
  assert.doesNotMatch(c.blockerReport(), /✅/);
});

await test("probing plausible paths that do not exist is discovery, not spinning", async () => {
  // The worst misfire: an agent guessing where a component lives got no credit
  // for a failed read, so it was stopped on turn 3 having read nothing at all.
  const c = createTaskController({ task: "resume the partial command palette implementation" });
  const { verdict, turnsRun } = drive(c, [
    (x) => x.recordToolCall({ tool: "read_file", args: { path: "src/CommandPalette.tsx" }, ok: false, output: "ENOENT: no such file" }),
    (x) => x.recordToolCall({ tool: "read_file", args: { path: "app/CommandPalette.tsx" }, ok: false, output: "ENOENT: no such file" }),
    (x) => x.recordToolCall({ tool: "read_file", args: { path: "components/CommandPalette.tsx" }, ok: false, output: "ENOENT: no such file" }),
    (x) => read(x, "app/components/CommandPalette.tsx"),
  ]);
  assert.equal(verdict.stop, false, `the search was cut off at turn ${turnsRun}`);
});

await test("exploring with read-only shell commands counts as discovery", async () => {
  const c = createTaskController({ task: "resume the partial command palette implementation" });
  const sh = (x, command) => x.recordToolCall({ tool: "bash", args: { command }, ok: true });
  const { verdict } = drive(c, [
    (x) => read(x, "app/page.tsx"),
    (x) => sh(x, "ls -R app/components"),
    (x) => sh(x, "cat package.json"),
    (x) => sh(x, "git log --oneline -10"),
  ]);
  assert.equal(verdict.stop, false, "ls/cat/git are how agents actually explore");

  // But the same command over and over is still nothing.
  const stuck = createTaskController({ task: "resume the palette work" });
  const b = drive(stuck, Array.from({ length: 12 }, () => (x) => sh(x, "ls -R app")));
  assert.equal(b.verdict.stop, true);
  assert.equal(b.verdict.reason, "no_progress");
});

await test("a read-only shell command is still not a mutation", async () => {
  // Crediting bash as discovery must not leak into the intent gate.
  const c = createTaskController({ task: "Add a skeleton component" });
  c.recordToolCall({ tool: "bash", args: { command: "ls -R app" }, ok: true });
  assert.equal(c.mutations, 0);
  assert.equal(c.canFinish({ responseText: "Here it is." }).allowed, false);
});

await test("REQUIRED: editing the same file with unchanged errors is thrashing", async () => {
  const c = createTaskController({ task: "Fix the type error" });
  const { verdict } = drive(c, Array.from({ length: 8 }, () => (x) => {
    edit(x, "src/Button.tsx");
    typecheck(x, TS_ERROR);
  }));
  assert.equal(verdict.stop, true);
  assert.equal(verdict.reason, "thrashing");
  assert.match(verdict.detail, /Rewrote src\/Button\.tsx/);
});

await test("paging through a long file is new information, not spinning", async () => {
  // The old key was the path alone, so reading chunks 2, 3 and 4 of a large
  // file looked like three dead turns and killed the task mid-read.
  const c = createTaskController({ task: "refactor the reducer" });
  const { verdict, turnsRun } = drive(c, [
    (x) => read(x, "src/reducer.ts"),
    (x) => read(x, "src/reducer.ts", { offset: 200 }),
    (x) => read(x, "src/reducer.ts", { offset: 400 }),
    (x) => read(x, "src/reducer.ts", { offset: 600 }),
    (x) => read(x, "src/reducer.ts", { offset: 800 }),
  ]);
  assert.equal(verdict.stop, false, `paging was cut off at turn ${turnsRun}`);
});

await test("the same search scoped to different directories is a different question", async () => {
  const c = createTaskController({ task: "migrate the logger calls" });
  const { verdict } = drive(c, [
    (x) => grep(x, "logger", "src"),
    (x) => grep(x, "logger", "app"),
    (x) => grep(x, "logger", "lib"),
    (x) => grep(x, "logger", "scripts"),
  ]);
  assert.equal(verdict.stop, false);
});

await test("an identical search repeated verbatim is not new information", async () => {
  const c = createTaskController({ task: "migrate the logger calls" });
  const { verdict } = drive(c, Array.from({ length: 12 }, () => (x) => grep(x, "logger", "src")));
  assert.equal(verdict.stop, true);
  assert.equal(verdict.reason, "no_progress");
});

await test("planning turns count as work — but only when the plan actually changes", async () => {
  const advancing = createTaskController({ task: "Add a command palette entry" });
  const a = drive(advancing, [
    (x) => read(x, "App.tsx"),
    (x) => plan(x, ["find the registry"]),
    (x) => plan(x, ["find the registry", "add the entry"]),
    (x) => plan(x, ["find the registry", "add the entry", "verify"]),
  ]);
  assert.equal(a.verdict.stop, false, "a plan being refined is progress");
  assert.equal(a.verdict.phase, "PLANNING");

  const stuck = createTaskController({ task: "Add a command palette entry" });
  const b = drive(stuck, [
    (x) => read(x, "App.tsx"),
    (x) => plan(x, ["do the thing"]),
    (x) => plan(x, ["do the thing"]),
    (x) => plan(x, ["do the thing"]),
    (x) => plan(x, ["do the thing"]),
  ]);
  assert.equal(b.verdict.stop, true, "re-submitting an identical plan is not progress");
  assert.equal(b.verdict.reason, "no_progress");
});

await test("the phase advances through the task and is reported on each verdict", async () => {
  const c = createTaskController({ task: "Add a skeleton component" });
  read(c, "app/page.tsx");
  assert.equal(c.endIteration().phase, "DISCOVERY");
  plan(c, ["write Skeleton.tsx"]);
  assert.equal(c.endIteration().phase, "PLANNING");
  c.recordToolCall({ tool: "write_file", args: { path: "app/Skeleton.tsx" }, ok: true });
  assert.equal(c.endIteration().phase, "IMPLEMENTATION");
  typecheck(c);
  assert.equal(c.endIteration().phase, "VERIFICATION");
  assert.ok(PHASES.includes(c.phase));
});

await test("a complete healthy task runs end to end without tripping anything", async () => {
  const c = createTaskController({ task: "Add a loading skeleton component." });
  const { verdict } = drive(c, [
    (x) => read(x, "app/components/Card.tsx"),
    (x) => grep(x, "className="),
    (x) => read(x, "app/globals.css"),
    (x) => plan(x, ["create Skeleton.tsx", "use it in Card"]),
    (x) => x.recordToolCall({ tool: "write_file", args: { path: "app/components/Skeleton.tsx" }, ok: true }),
    (x) => edit(x, "app/components/Card.tsx"),
    (x) => typecheck(x, TS_ERROR),
    (x) => edit(x, "app/components/Card.tsx"),
    (x) => typecheck(x),
  ]);
  assert.equal(verdict.stop, false, "a normal implementation must run to completion");
  assert.equal(c.canFinish().allowed, true);
  assert.equal(c.stopReason, "verified");
});

console.log("\n── the discovery budget ─────────────────────────────────────");

await test("exploration is nudged toward implementation once the budget is spent", async () => {
  const c = createTaskController({ task: "Add a command palette entry", maxDiscoveryTurns: 5 });
  let verdict;
  for (let i = 0; i < 5; i++) {
    read(c, `src/f${i}.ts`);
    verdict = c.endIteration();
  }
  assert.equal(verdict.stop, false, "the budget steers, it does not kill the task");
  assert.match(verdict.directive, /That is enough reading/);
  assert.match(verdict.directive, /start making the edits/);
  assert.equal(c.snapshot().discoveryCapped, true);
});

await test("browsing past the discovery budget eventually stops the task", async () => {
  const c = createTaskController({ task: "Add a command palette entry", maxDiscoveryTurns: 5 });
  const { verdict, turnsRun } = drive(c, Array.from({ length: 30 }, (_, i) => (x) => read(x, `src/f${i}.ts`)));
  assert.equal(verdict.stop, true, "unlimited exploration must not be possible");
  assert.equal(verdict.reason, "no_progress");
  assert.ok(turnsRun < 12, `took ${turnsRun} turns to stop endless browsing`);
});

await test("the discovery budget does not fire once real work has started", async () => {
  const c = createTaskController({ task: "Add a skeleton", maxDiscoveryTurns: 3 });
  c.recordToolCall({ tool: "write_file", args: { path: "a.tsx" }, ok: true });
  c.endIteration();
  // Now in IMPLEMENTATION: reading to support an edit must not be capped.
  const { verdict } = drive(c, [
    (x) => read(x, "b.tsx"),
    (x) => edit(x, "b.tsx"),
    (x) => read(x, "c.tsx"),
  ]);
  assert.equal(verdict.stop, false);
  assert.equal(verdict.directive, undefined, "no discovery nudge outside discovery");
});

console.log("\n── execution budget & termination policy ────────────────────");

await test("REQUIRED: repeated no-progress iterations stop the task early", async () => {
  const c = createTaskController();

  // A productive opening turn, so the streak has to build from zero.
  c.recordToolCall({ tool: "read_file", args: { path: "src/a.ts" }, ok: true });
  assert.equal(c.endIteration().progressed, true);

  // Now the agent spins: re-reading what it already read, changing nothing.
  // The first stall buys one directive; the second is terminal.
  let verdict = { stop: false };
  let dead = 0;
  while (!verdict.stop && dead < 10) {
    dead++;
    c.recordToolCall({ tool: "read_file", args: { path: "src/a.ts" }, ok: true });
    verdict = c.endIteration();
  }

  assert.equal(verdict.stop, true, "sustained dead turns must end the task");
  assert.equal(verdict.reason, "no_progress");
  // The wording varies by task shape — a question is not accused of failing
  // to change files — but every variant must name the stall itself.
  assert.match(verdict.detail, /turned up nothing new|changed nothing/);
  assert.ok(verdict.iterations < 10, `stopped at step ${verdict.iterations}, far short of the budget`);
});

await test("REQUIRED: quota-style runaway is prevented — a stuck task cannot reach the budget", async () => {
  // The runaway shape: edit, same error, edit, same error… forever. Given a
  // 40-step budget, a task like this used to consume all 40.
  const c = createTaskController({ maxIterations: 40 });

  let verdict = { stop: false };
  let steps = 0;
  while (!verdict.stop && steps < 100) {
    steps++;
    edit(c, "src/Button.tsx");
    typecheck(c, TS_ERROR);
    verdict = c.endIteration();
  }

  assert.equal(verdict.stop, true, "the loop must be terminated by the controller");
  assert.ok(steps < 40, `runaway not prevented: ran ${steps} of 40 steps`);
  assert.ok(
    ["blocked", "thrashing", "no_progress"].includes(verdict.reason),
    `expected a stuck-reason, got ${verdict.reason}`,
  );
  // And it never silently claims success.
  assert.notEqual(verdict.reason, "verified");
});

await test("the hard iteration ceiling yields budget_exhausted, not an anonymous fall-out", async () => {
  // Every turn genuinely progresses (a new file each time), so no stuck-detector
  // fires — only the ceiling itself can end this.
  const c = createTaskController({ maxIterations: 5 });
  let verdict;
  for (let i = 0; i < 5; i++) {
    c.recordToolCall({ tool: "read_file", args: { path: `src/f${i}.ts` }, ok: true });
    verdict = c.endIteration();
  }
  assert.equal(verdict.stop, true);
  assert.equal(verdict.reason, "budget_exhausted");
  assert.match(verdict.detail, /5-step limit/);
});

await test("hitting the same error wall repeatedly reports blocked", async () => {
  const c = createTaskController({ maxNoProgress: 99, maxSameFileWrites: 99 });
  let verdict;
  for (let i = 0; i < 4; i++) {
    // Vary the file each time, so this is a genuine wall rather than thrashing.
    edit(c, `src/f${i}.ts`);
    typecheck(c, TS_ERROR);
    verdict = c.endIteration();
  }
  assert.equal(verdict.stop, true);
  assert.equal(verdict.reason, "blocked");
  assert.match(verdict.detail, /survived 4 attempts/);
});

await test("re-planning past the allowance is terminal", async () => {
  const c = createTaskController({ maxReplans: 2, maxNoProgress: 99, maxSameFileWrites: 99, maxSameErrorRetries: 99 });
  for (let i = 0; i < 3; i++) c.escalateStrategy();
  edit(c, "src/a.ts");
  const verdict = c.endIteration();
  assert.equal(verdict.stop, true);
  assert.equal(verdict.reason, "thrashing");
  assert.match(verdict.detail, /Re-planned/);
});

await test("a healthy task runs to completion without tripping any limit", async () => {
  const c = createTaskController();

  c.recordToolCall({ tool: "grep", args: { pattern: "handler" }, ok: true });
  assert.equal(c.endIteration().stop, false);

  c.recordToolCall({ tool: "read_file", args: { path: "src/server.ts" }, ok: true });
  assert.equal(c.endIteration().stop, false);

  edit(c, "src/server.ts");
  assert.equal(c.endIteration().stop, false);

  typecheck(c, TS_ERROR);          // one honest failure
  assert.equal(c.endIteration().stop, false);

  edit(c, "src/server.ts");
  typecheck(c);                    // fixed
  const last = c.endIteration();
  assert.equal(last.stop, false, "a normal fix-then-verify task must not be cut short");
  assert.equal(last.progressed, true);

  const gate = c.canFinish();
  assert.equal(gate.allowed, true);
  assert.equal(c.stopReason, "verified", "a real success is labelled verified");
});

await test("progress is credited for each distinct signal", async () => {
  const c = createTaskController();
  c.recordToolCall({ tool: "read_file", args: { path: "new.ts" }, ok: true });
  assert.match(c.endIteration().reasons.join(","), /inspected new files/);

  edit(c, "fresh.ts");
  assert.match(c.endIteration().reasons.join(","), /edited a new file/);

  typecheck(c, TS_ERROR);
  assert.match(c.endIteration().reasons.join(","), /ran verification|diagnostics changed/);

  typecheck(c);
  assert.match(c.endIteration().reasons.join(","), /verification now passes/);
});

console.log("\n── the honest blocker report ────────────────────────────────");

await test("an early stop reports the real blocker instead of claiming completion", async () => {
  const c = createTaskController();
  let verdict = { stop: false };
  let steps = 0;
  while (!verdict.stop && steps < 100) {
    steps++;
    edit(c, "src/Button.tsx");
    typecheck(c, TS_ERROR);
    verdict = c.endIteration();
  }

  const report = c.blockerReport();
  assert.match(report, /Stopped early/, "it says plainly that it stopped");
  assert.match(report, /did not finish/i, "it does not imply completion");
  assert.match(report, /src\/Button\.tsx/, "it names what it touched");
  assert.match(report, /still failing/i, "it states the verification truth");
  assert.doesNotMatch(report, /✅|successfully completed/i, "no success theatre");
});

await test("a report on a run that never verified says so explicitly", async () => {
  const c = createTaskController({ maxNoProgress: 1 });
  edit(c, "a.ts");
  c.endIteration();
  edit(c, "a.ts");           // same file again — no progress
  const verdict = c.endIteration();
  assert.equal(verdict.stop, true);
  assert.match(c.blockerReport(), /No verification was run/);
});

await test("blockerReport is empty while the task is still healthy", async () => {
  const c = createTaskController();
  c.recordToolCall({ tool: "read_file", args: { path: "a.ts" }, ok: true });
  c.endIteration();
  assert.equal(c.blockerReport(), "", "nothing to report — it has not stopped");
});

console.log("\n── the verify gate survives the budget work ─────────────────");

await test("REQUIRED: verification still blocks a false success claim", async () => {
  const c = createTaskController();
  edit(c, "src/payment.ts");
  c.endIteration();

  const gate = c.canFinish();
  assert.equal(gate.allowed, false, "unverified edits still cannot be called done");
  assert.match(gate.reason, /no verification/);
  assert.notEqual(c.stopReason, "verified");

  // Even a failing check does not unlock it.
  typecheck(c, TS_ERROR);
  const afterFailure = c.canFinish();
  assert.equal(afterFailure.allowed, false, "a FAILING check is not a pass");
  assert.notEqual(c.stopReason, "verified");

  // Only a real pass does.
  typecheck(c);
  assert.equal(c.canFinish().allowed, true);
  assert.equal(c.stopReason, "verified");
});

console.log("\n── recovery memory ──────────────────────────────────────────");

await test("REQUIRED: a failed action is remembered with tool, target and error", async () => {
  const c = createTaskController({ task: "Fix the build" });
  c.recordToolCall({ tool: "edit_file", args: { path: "src/App.tsx" }, ok: false, output: "EACCES: permission denied, open 'src/App.tsx'" });
  const [f] = c.snapshot().failures;
  assert.equal(f.tool, "edit_file");
  assert.equal(f.target, "src/App.tsx");
  assert.match(f.reason, /EACCES/);
  assert.equal(f.count, 1);
});

await test("REQUIRED: repeating a failed action triggers a change-of-strategy directive", async () => {
  const c = createTaskController({ task: "Fix the build" });
  const fail = () => c.recordToolCall({ tool: "bash", args: { command: "pytest" }, ok: false, output: "sh: pytest: command not found" });
  fail();
  assert.equal(c.endIteration().directive, undefined, "one failure is not yet a pattern");
  fail();
  const v = c.endIteration();
  assert.equal(v.directiveKind, "recovery");
  assert.match(v.directive, /failed 2 times/);
  assert.match(v.directive, /command not found/);
  // The point of the redirect is the CONCRETE alternative. "Try something
  // else" gets answered with a reworded version of the same call; naming the
  // replacement does not.
  assert.match(v.directive, /Do this instead/);
  assert.match(v.directive, /manifest|package\.json|Makefile/i, "a missing binary must point at the project's real scripts");
  assert.match(v.strategy, /manifest|package\.json/i, "the strategy is exposed separately for the loop to act on");
});

await test("the same dead end is flagged once, not on every later turn", async () => {
  const c = createTaskController({ task: "Fix the build" });
  for (let i = 0; i < 3; i++) c.recordToolCall({ tool: "bash", args: { command: "pytest" }, ok: false, output: "sh: pytest: command not found" });
  assert.equal(c.endIteration().directiveKind, "recovery");
  c.recordToolCall({ tool: "bash", args: { command: "pytest" }, ok: false, output: "sh: pytest: command not found" });
  assert.notEqual(c.endIteration().directiveKind, "recovery", "nagging every turn is noise");
});

await test("the same action failing a DIFFERENT way is not the same dead end", async () => {
  const c = createTaskController({ task: "Fix the build" });
  c.recordToolCall({ tool: "edit_file", args: { path: "a.ts" }, ok: false, output: "EACCES: permission denied" });
  c.recordToolCall({ tool: "edit_file", args: { path: "a.ts" }, ok: false, output: "ENOSPC: no space left on device" });
  assert.equal(c.endIteration().directive, undefined, "the error moved — that is new information");
  assert.equal(c.snapshot().failures.length, 2);
});

await test("failureSignature ignores volatile detail so the same wall compares equal", async () => {
  const a = failureSignature("Error: connect ECONNREFUSED 127.0.0.1:5432");
  const b = failureSignature("Error: connect ECONNREFUSED 127.0.0.1:5433");
  assert.equal(a, b, "a differing port is the same failure");
  assert.notEqual(failureSignature("EACCES: denied"), failureSignature("ENOENT: missing"));
  assert.equal(failureSignature(""), null);
});

await test("failureSignature skips stack frames and reads the real message", async () => {
  const sig = failureSignature("    at Module._load (node:internal)\nError: Cannot find module 'zod'\n    at require");
  assert.match(sig, /cannot find module/);
});

console.log("\n── completion discipline ────────────────────────────────────");

await test("REQUIRED: the first edit does not end a multi-step task", async () => {
  const c = createTaskController({ task: "implement a command palette" });
  c.recordToolCall({ tool: "todo_write", args: { todos: [
    { content: "create Palette.tsx", status: "pending" },
    { content: "wire the shortcut", status: "pending" },
    { content: "add tests", status: "pending" },
  ] }, ok: true });
  c.recordToolCall({ tool: "edit_file", args: { path: "App.tsx" }, ok: true });

  const gate = c.canFinish({ editedPaths: ["App.tsx"] });
  assert.equal(gate.allowed, false);
  assert.match(gate.directive, /3 of 3 planned items are still open/);
  assert.match(gate.directive, /create Palette\.tsx/);
});

await test("REQUIRED: ticking the plan off allows the run to finish", async () => {
  const c = createTaskController({ task: "implement a command palette" });
  c.recordToolCall({ tool: "todo_write", args: { todos: [{ content: "wire it", status: "pending" }] }, ok: true });
  c.recordToolCall({ tool: "edit_file", args: { path: "App.tsx" }, ok: true });
  assert.equal(c.canFinish({ editedPaths: ["App.tsx"] }).allowed, false);

  c.recordToolCall({ tool: "todo_write", args: { todos: [{ content: "wire it", status: "completed" }] }, ok: true });
  c.recordToolCall({ tool: "bash", args: { command: "npm run typecheck" }, ok: true, output: "ok" });

  // One bounded challenge still applies: a ticked box is the agent's own
  // account, not evidence about the workspace. It costs a single turn.
  const challenged = c.canFinish({ editedPaths: ["App.tsx"] });
  assert.equal(challenged.allowed, false);
  assert.equal(challenged.kind, "incomplete_shape");

  const gate = c.canFinish({ editedPaths: ["App.tsx"] });
  assert.equal(gate.allowed, true, gate.reason);
  assert.equal(gate.verified, true);
});

await test("a run with no plan is not held back by the completion gate", async () => {
  const c = createTaskController({ task: "fix the typo in the header" });
  c.recordToolCall({ tool: "edit_file", args: { path: "Header.tsx" }, ok: true });
  c.recordToolCall({ tool: "bash", args: { command: "npm run typecheck" }, ok: true, output: "ok" });
  assert.equal(c.canFinish({ editedPaths: ["Header.tsx"] }).allowed, true, "a one-step task needs no todo list");
});

await test("an unfinished plan cannot trap the run forever — it ends, flagged", async () => {
  const c = createTaskController({ task: "implement a command palette" });
  c.recordToolCall({ tool: "todo_write", args: { todos: [{ content: "wire it", status: "pending" }] }, ok: true });
  c.recordToolCall({ tool: "edit_file", args: { path: "App.tsx" }, ok: true });
  c.recordToolCall({ tool: "bash", args: { command: "npm run typecheck" }, ok: true, output: "ok" });

  let gate;
  for (let i = 0; i < 5; i++) gate = c.canFinish({ editedPaths: ["App.tsx"] });
  assert.equal(gate.allowed, true, "must terminate rather than spin");
  assert.equal(gate.incomplete, true, "but reported as NOT fully delivered");
  assert.deepEqual(gate.openItems, ["wire it"]);
});

await test("REQUIRED: a multi-part request is challenged after a single edit", async () => {
  const c = createTaskController({ task: "implement a VS Code-style command palette" });
  c.recordToolCall({ tool: "edit_file", args: { path: "App.tsx" }, ok: true });
  c.recordToolCall({ tool: "bash", args: { command: "npm run typecheck" }, ok: true, output: "ok" });

  const first = c.canFinish({ editedPaths: ["App.tsx"] });
  assert.equal(first.allowed, false, "one file for a whole feature deserves a second look");
  assert.equal(first.kind, "incomplete_shape");
  assert.match(first.directive, /only 1 file changed/);

  // Asked once only — a genuine one-file feature must not be trapped.
  const second = c.canFinish({ editedPaths: ["App.tsx"] });
  assert.equal(second.allowed, true);
  assert.equal(second.verified, true);
});

await test("a plainly single-step task is never challenged", async () => {
  const c = createTaskController({ task: "fix the typo in Header.tsx" });
  c.recordToolCall({ tool: "edit_file", args: { path: "Header.tsx" }, ok: true });
  c.recordToolCall({ tool: "bash", args: { command: "npm run typecheck" }, ok: true, output: "ok" });
  assert.equal(c.canFinish({ editedPaths: ["Header.tsx"] }).allowed, true);
});

await test("looksMultiStep stays narrow — it costs a turn when wrong", async () => {
  for (const t of ["implement a VS Code-style command palette", "add pagination and then wire it to the API",
                   "implement the auth flow with tests", "1. add a route\n2. add a test"]) {
    assert.equal(looksMultiStep(t), true, `should be multi-step: "${t}"`);
  }
  for (const t of ["fix the typo in Header.tsx", "rename the variable", "add a loading skeleton component",
                   "explain this component"]) {
    assert.equal(looksMultiStep(t), false, `should NOT be multi-step: "${t}"`);
  }
});

console.log("\n── honest blockers ──────────────────────────────────────────");

await test("REQUIRED: a missing binary stops as blocked, naming the cause", async () => {
  const c = createTaskController({ task: "run the tests" });
  let verdict;
  for (let i = 0; i < 5; i++) {
    c.recordToolCall({ tool: "bash", args: { command: "npm test" }, ok: false, output: "sh: vitest: command not found" });
    verdict = c.endIteration();
    if (verdict.stop) break;
  }
  assert.equal(verdict.stop, true);
  assert.equal(verdict.reason, "blocked", `expected blocked, got ${verdict.reason}`);
  assert.match(verdict.detail, /command not found/);
});

await test("the blocker report lists what repeatedly failed", async () => {
  const c = createTaskController({ task: "run the tests" });
  for (let i = 0; i < 5; i++) {
    c.recordToolCall({ tool: "bash", args: { command: "npm test" }, ok: false, output: "sh: vitest: command not found" });
    if (c.endIteration().stop) break;
  }
  const report = c.blockerReport();
  assert.match(report, /What repeatedly failed/);
  assert.match(report, /command not found/);
  assert.doesNotMatch(report, /✅/);
});

await test("the blocker report names plan items left open", async () => {
  const c = createTaskController({ task: "implement a palette" });
  c.recordToolCall({ tool: "todo_write", args: { todos: [
    { content: "create Palette.tsx", status: "completed" },
    { content: "add tests", status: "pending" },
  ] }, ok: true });
  for (let i = 0; i < 12; i++) {
    c.recordToolCall({ tool: "edit_file", args: { path: "App.tsx" }, ok: true });
    c.recordToolCall({ tool: "bash", args: { command: "npm run typecheck" }, ok: false, output: TS_ERROR });
    if (c.endIteration().stop) break;
  }
  assert.match(c.blockerReport(), /Still open from the plan: add tests/);
});

console.log("\n── wiring into the real tool loop ───────────────────────────");

// The unit tests above drive the controller directly. These prove the loop
// actually feeds it — that the record call sits on the real execution path
// and sees genuine tool results, not a hand-built approximation.

await test("executeToolCallsBatch records real executed calls into the controller", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-tc-"));
  await fs.writeFile(path.join(root, "target.txt"), "before");

  const controller = createTaskController();
  const ctx = {
    root, emit: null, sessionId: "s", requestId: "r", hooks: {},
    runtime: new HostRuntime({ root }),
    editedFiles: new Map(), readFiles: new Set(), todosRef: { current: [] },
    workspaceSnapshot: [], permissionMode: "auto",
    taskController: controller,
  };

  await executeToolCallsBatch([
    { id: "c1", function: { name: "read_file", arguments: JSON.stringify({ path: "target.txt" }) } },
    { id: "c2", function: { name: "write_file", arguments: JSON.stringify({ path: "target.txt", content: "after" }) } },
  ], ctx, 1, 40, null);

  const snap = controller.snapshot();
  assert.equal(snap.toolCalls, 2, "both executed calls were recorded");
  assert.ok(snap.editedPaths.includes("target.txt"), "the write was seen as an edit");
  assert.equal(snap.state, "patch", "a write moves the machine into patch");

  // And the gate holds on the real edit set the loop tracks.
  const gate = controller.canFinish({ editedPaths: ctx.editedFiles.keys() });
  assert.equal(gate.allowed, false, "an unverified real edit cannot finish");

  await fs.rm(root, { recursive: true, force: true });
});

await test("a controller-less ctx (sub-agent path) still executes tools fine", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-tc-"));
  await fs.writeFile(path.join(root, "a.txt"), "hi");
  const ctx = {
    root, emit: null, sessionId: "s", requestId: "r", hooks: {},
    runtime: new HostRuntime({ root }),
    editedFiles: new Map(), readFiles: new Set(), todosRef: { current: [] },
    workspaceSnapshot: [], permissionMode: "auto",
    // no taskController — must not throw
  };
  const results = await executeToolCallsBatch(
    [{ id: "c1", function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) } }],
    ctx, 1, 40, null,
  );
  assert.equal(results.length, 1);
  assert.ok(JSON.parse(results[0].content).content.includes("hi"));
  await fs.rm(root, { recursive: true, force: true });
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
