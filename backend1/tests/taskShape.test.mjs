/**
 * tests/taskShape.test.mjs
 * Run with: node tests/taskShape.test.mjs
 *
 * TASK-SHAPE PARITY
 *
 * The controller used to reason almost entirely from counters: how many turns,
 * how many edits, how many failures. That is enough to stop a runaway loop and
 * not enough to finish a task well, because it cannot tell the difference
 * between a typo fix and a feature — and so judged both by the same rules.
 *
 * These scenarios pin the five behaviours that replaced the counters:
 *
 *   A. intent      — the request is classified into a task shape
 *   B. progress    — what counts as progress depends on that shape and phase
 *   C. strategy    — a failing tool path is redirected to a NAMED alternative
 *   D. budget      — discovery and iteration budgets vary by shape
 *   E. completion  — "done" is checked against the request, not just the todos
 *
 * Written as replays wherever the behaviour is a property of a whole run,
 * because that is how every one of these bugs actually presented: not as a
 * wrong return value, but as a run that ended in the wrong place.
 */

import assert from "assert";
import {
  createTaskController, classifyTask, budgetFor, alternativeStrategy, isTestPath,
  looksMultiStep, verificationOutcome, TASK_SHAPES,
} from "../services/taskController.mjs";

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

// ── turn builders, mirroring how the loop reports calls ─────────────────────
const read     = (p, extra = {}) => (c) => c.recordToolCall({ tool: "read_file", args: { path: p, ...extra }, ok: true });
const readFail = (p, err = "ENOENT: no such file or directory") => (c) => c.recordToolCall({ tool: "read_file", args: { path: p }, ok: false, output: err });
const glob     = (g)             => (c) => c.recordToolCall({ tool: "glob", args: { glob: g }, ok: true });
const write    = (p)             => (c) => c.recordToolCall({ tool: "write_file", args: { path: p }, ok: true });
const edit     = (p)             => (c) => c.recordToolCall({ tool: "edit_file", args: { path: p }, ok: true });
const editFail = (p, err)        => (c) => c.recordToolCall({ tool: "edit_file", args: { path: p }, ok: false, output: err });
const shFail   = (cmd, err)      => (c) => c.recordToolCall({ tool: "bash", args: { command: cmd }, ok: false, output: err });
const plan     = (...items)      => (c) => c.recordToolCall({ tool: "todo_write", args: { todos: items }, ok: true });
const verify   = (out = "")      => (c) => c.recordToolCall({ tool: "bash", args: { command: "npm run typecheck" }, ok: !out, output: out });
const todo = (content, status = "pending") => ({ content, status });

/** Replay turns until the controller stops. */
function run(task, turns, opts = {}) {
  const c = createTaskController({ task, ...opts });
  let verdict = { stop: false };
  let turnsRun = 0;
  const directives = [];
  for (const turn of turns) {
    turnsRun++;
    turn(c);
    verdict = c.endIteration();
    if (verdict.directive) directives.push({ kind: verdict.directiveKind, text: verdict.directive });
    if (verdict.stop) break;
  }
  return { c, verdict, turnsRun, directives, snapshot: c.snapshot() };
}

console.log("\n══ A. workspace intent tracking ══════════════════════════════");

await test("every shape the classifier can emit is a declared shape", async () => {
  const samples = [
    "explain how the router works", "fix the typo in Header.tsx",
    "resume the half-built palette", "add tests for the parser",
    "refactor the reducer", "implement a command palette with tests",
  ];
  for (const s of samples) {
    assert.ok(TASK_SHAPES.includes(classifyTask(s).shape), `unknown shape for "${s}"`);
  }
});

await test("a question is a question, whatever verbs it contains", async () => {
  for (const t of [
    "Explain how the router picks a node",
    "What does this component do?",
    "how would you refactor this reducer?",
    "just show me the code for a debounce hook",
    "should we migrate to zod?",
  ]) {
    const i = classifyTask(t);
    assert.equal(i.shape, "question", `"${t}" → ${i.shape}`);
    assert.equal(i.requiresMutation, false, `"${t}" must never be forced to mutate`);
  }
});

await test("a named file or a narrow phrase means a single-file fix", async () => {
  for (const t of [
    "Fix the type error in App.tsx",
    "update src/lib/api.ts to send the auth header",
    "fix the typo in the header",
    "fix this bug in the date parser",
  ]) {
    assert.equal(classifyTask(t).shape, "single_file_fix", `"${t}"`);
  }
});

await test("picking up unfinished work is its own shape", async () => {
  for (const t of [
    "resume the partial command palette implementation",
    "could you please finish the settings page",
    "continue where you left off on the migration script",
    "the palette is half-built — complete it",
  ]) {
    assert.equal(classifyTask(t).shape, "resume", `"${t}"`);
  }
});

await test("a test task is recognised only when tests ARE the deliverable", async () => {
  assert.equal(classifyTask("add tests for the parser").shape, "test_only");
  assert.equal(classifyTask("fix the failing tests").shape, "test_only");
  assert.equal(classifyTask("write unit tests for commandPalette.ts").shape, "test_only");
  // Tests as one part of a larger build must NOT collapse the task to test-only.
  assert.equal(classifyTask("implement a command palette and add tests").shape, "multi_file");
  assert.equal(classifyTask("build the auth flow with tests").shape, "multi_file");
});

await test("restructuring is a refactor, not a feature", async () => {
  for (const t of ["refactor the reducer", "migrate the routes to the app router", "extract the shared logic into a hook"]) {
    assert.equal(classifyTask(t).shape, "refactor", `"${t}"`);
  }
});

await test("an unclassifiable action defaults to the generous shape", async () => {
  // Unknown scope must earn a LONG leash, not a short one — guessing small is
  // what ends a run half-done.
  const i = classifyTask("add a dark mode toggle");
  assert.equal(i.shape, "multi_file");
  assert.equal(i.multiPart, false, "…but with no positive evidence of breadth");
});

await test("standalone requirements are read off the request text", async () => {
  const a = classifyTask("implement a command palette and wire it up with tests");
  assert.equal(a.mentionsTests, true);
  assert.equal(a.mentionsIntegration, true);
  const b = classifyTask("add a dark mode toggle");
  assert.equal(b.mentionsTests, false);
  assert.equal(b.mentionsIntegration, false);
});

await test("waiving tests is not the same as asking for them", async () => {
  // The word `tests` appears either way. Reading a waiver as a requirement
  // would demand the exact work the user just declined.
  for (const t of ["add a dark mode toggle, no tests needed", "add a palette but don't write tests",
                   "update the parser without tests"]) {
    assert.equal(classifyTask(t).mentionsTests, false, `"${t}"`);
  }
  // The waiver must not be the thing that makes a request look multi-part —
  // though a request that is multi-part for OTHER reasons still is one.
  assert.equal(looksMultiStep("add a dark mode toggle, no tests needed"), false);
  assert.equal(looksMultiStep("update the parser without tests"), false);
  assert.equal(looksMultiStep("add a palette but don't write tests"), true,
    "a palette is still a feature, waiver or not");
  // A waiver must actually let the run finish on one file.
  const c = createTaskController({ task: "add a dark mode toggle, no tests needed" });
  read("app/theme.ts")(c);
  edit("app/theme.ts")(c);
  verify()(c);
  assert.equal(c.canFinish({ editedPaths: ["app/theme.ts"] }).allowed, true);
});

await test("the shape is exposed on the controller and in the snapshot", async () => {
  const c = createTaskController({ task: "resume the partial palette" });
  assert.equal(c.shape, "resume");
  assert.equal(c.snapshot().shape, "resume");
  assert.equal(c.snapshot().budget.maxDiscoveryTurns, budgetFor("resume").maxDiscoveryTurns);
});

console.log("\n══ B. semantic progress detection ════════════════════════════");

await test("a question keeps earning progress from reading all the way through", async () => {
  // The implementation-phase rule would starve exactly the task that is
  // behaving correctly: a question has no edits to make.
  const r = run("Explain how the agent loop decides to stop", [
    read("agents/nodes/agent_loop.mjs"),
    read("services/taskController.mjs"),
    read("services/hooks.mjs"),
    read("agents/router.mjs"),
    read("services/sessionHooks.mjs"),
  ]);
  assert.equal(r.verdict.stop, false, `a question was cut off at turn ${r.turnsRun}`);
  assert.ok(r.verdict.progressed, "reading is the work for a question");
});

await test("clearing a blocker is progress that no counter would notice", async () => {
  // The file was read (so nothing new is learned), the path already failed
  // (so nothing new is discovered) — but getting it to work IS the recovery
  // paying off, and without this it reads as a dead turn.
  const c = createTaskController({ task: "fix the config loader in config.ts" });
  readFail("config/app.yml")(c);
  c.endIteration();
  read("config/app.yml")(c);
  const v = c.endIteration();
  assert.ok(v.progressed, "a previously failing action now succeeding is progress");
  assert.match(v.reasons.join(","), /cleared a blocker/);
  assert.equal(c.snapshot().resolvedBlockers, 1);
});

await test("the same failing action repeated is never progress", async () => {
  const r = run("fix the build in server.mjs", [
    shFail("npm run build", "Error: cannot find module 'zod'"),
    shFail("npm run build", "Error: cannot find module 'zod'"),
    shFail("npm run build", "Error: cannot find module 'zod'"),
  ]);
  const later = r.snapshot;
  assert.ok(later.failures.some((f) => f.count >= 2), "the repeat must be remembered");
});

await test("useful exploration and dead-end exploration end differently", async () => {
  const useful = run("add pagination to the users list", [
    glob("**/users/**"),
    read("app/users/page.tsx"),
    read("app/hooks/useUsers.ts"),
    readFail("app/users/Pagination.tsx"),
    read("app/lib/api.ts"),
    read("app/components/Table.tsx"),
  ]);
  assert.equal(useful.verdict.stop, false, `varied discovery was cut off at turn ${useful.turnsRun}`);

  const deadEnd = run("add pagination to the users list",
    Array.from({ length: 12 }, () => read("app/users/page.tsx")));
  assert.equal(deadEnd.verdict.stop, true, "re-reading one file forever must end");
  assert.equal(deadEnd.verdict.reason, "no_progress");
});

console.log("\n══ C. tool strategy adaptation ═══════════════════════════════");

await test("each failing tool path is redirected to a NAMED alternative", async () => {
  assert.match(alternativeStrategy("read_file", "ENOENT: no such file"), /glob|grep/);
  assert.match(alternativeStrategy("glob", "no matches found"), /widen|parent directory|different symbol/i);
  assert.match(alternativeStrategy("edit_file", "no match for the given string"), /write_file|re-read/i);
  assert.match(alternativeStrategy("write_file", "ENOENT: missing directory"), /mkdir|apply_patch/);
  assert.match(alternativeStrategy("apply_patch", "patch does not apply"), /edit_file|write_file/);
  assert.match(alternativeStrategy("bash", "sh: vitest: command not found"), /manifest|package\.json|Makefile/i);
});

await test("a permission failure is never answered with 'try the same write again'", async () => {
  const s = alternativeStrategy("write_file", "EACCES: permission denied");
  assert.match(s, /location you can actually modify|report the permission/i);
  assert.match(s, /will be refused again|do not reword/i, "it must say the retry is futile");
});

await test("REPLAY: guessing paths with read_file is pushed onto glob", async () => {
  const r = run("resume the partial command palette implementation", [
    readFail("src/CommandPalette.tsx"),
    readFail("src/CommandPalette.tsx"),
    readFail("src/CommandPalette.tsx"),
  ]);
  const rec = r.directives.find((d) => d.kind === "recovery");
  assert.ok(rec, `no recovery directive; got ${JSON.stringify(r.directives.map((d) => d.kind))}`);
  assert.match(rec.text, /glob|grep/, "must name the tool to switch to");
  assert.match(rec.text, /Do not repeat the call that failed/);
});

await test("REPLAY: a failing edit is pushed toward rewriting, not rephrasing", async () => {
  const r = run("fix the type error in Button.tsx", [
    read("src/Button.tsx"),
    editFail("src/Button.tsx", "no match found for the provided old_string"),
    editFail("src/Button.tsx", "no match found for the provided old_string"),
  ]);
  const rec = r.directives.find((d) => d.kind === "recovery");
  assert.ok(rec, "a repeated failing edit must be redirected");
  assert.match(rec.text, /write_file|re-read/i);
});

await test("REPLAY: ignoring the redirect ends the run with a named blocker", async () => {
  // The behaviour this protects: the agent is told exactly what to try
  // instead, goes back to the same wall, and the run quietly burns turns
  // "still exploring".
  const r = run("fix the config loader in config.ts",
    Array.from({ length: 10 }, () => editFail("config.ts", "EACCES: permission denied")));
  assert.equal(r.verdict.stop, true);
  assert.equal(r.verdict.reason, "blocked", `expected a named blocker, got ${r.verdict.reason}`);
  assert.match(r.verdict.detail, /EACCES|permission denied/i, "the report must name the real cause");
  assert.ok(r.turnsRun <= 6, `burned ${r.turnsRun} turns on a known dead end`);
});

await test("a redirect does not pre-empt the more specific thrash diagnosis", async () => {
  // "You rewrote this one file four times" is a better answer than "an action
  // kept failing", so the general rule must stay behind the specific one.
  const r = run("fix the type error in App.tsx", Array.from({ length: 12 }, () => (c) => {
    edit("src/App.tsx")(c);
    verify("src/App.tsx(42,7): error TS2322: Type 'string' is not assignable to type 'number'.")(c);
  }));
  assert.equal(r.verdict.reason, "thrashing", "the specific diagnosis must win");
});

console.log("\n══ D. dynamic budgeting ══════════════════════════════════════");

await test("discovery budgets differ by shape, shortest where the code exists", async () => {
  const d = (s) => budgetFor(s).maxDiscoveryTurns;
  assert.ok(d("resume") < d("single_file_fix"), "resuming known code needs the least discovery");
  assert.ok(d("single_file_fix") < d("multi_file"), "a scoped fix needs less discovery than a feature");
  assert.ok(d("multi_file") >= d("test_only"), "an unmapped feature gets the longest leash");
});

await test("iteration ceilings differ by shape", async () => {
  assert.ok(budgetFor("single_file_fix").maxIterations < budgetFor("multi_file").maxIterations,
    "a typo must not be allowed to burn a feature's quota");
});

await test("REPLAY: a resume task is pushed to act sooner than a feature task", async () => {
  const turns = Array.from({ length: 10 }, (_, i) => read(`src/file${i}.ts`));
  const resume = run("resume the partial command palette implementation", turns);
  const feature = run("implement a command palette with tests and wiring", turns);
  const at = (r) => r.directives.findIndex((d) => d.kind === "discovery_budget");
  assert.ok(at(resume) >= 0, "the resume task must be told to start editing");
  assert.ok(
    at(feature) === -1 || at(feature) > at(resume),
    "a feature must get at least as long to explore as a resume",
  );
});

await test("a question is never pushed into mutating anything", async () => {
  const r = run("Explain how the hooks system dispatches events",
    Array.from({ length: 20 }, (_, i) => read(`services/f${i}.mjs`)));
  assert.equal(r.c.requiresMutation, false);
  for (const d of r.directives) {
    assert.doesNotMatch(d.text, /write_file or edit_file to make the change real/,
      "a question must never be told to edit files");
  }
  const gate = r.c.canFinish({ responseText: "The dispatcher walks the registered hooks…" });
  assert.equal(gate.allowed, true, "a question finishes on an answer");
});

await test("an explicit threshold always beats the shape's budget", async () => {
  const c = createTaskController({ task: "implement a palette with tests", maxDiscoveryTurns: 2 });
  assert.equal(c.budget.maxDiscoveryTurns, 2, "callers and tests must still be able to pin thresholds");
});

console.log("\n══ E. completion beyond the todo list ════════════════════════");

await test("a request that asks for tests is not done without a test file", async () => {
  const c = createTaskController({ task: "implement a command palette and add tests" });
  read("app/App.tsx")(c);
  write("app/Palette.tsx")(c);
  edit("app/App.tsx")(c);
  verify()(c);
  const gate = c.canFinish({ editedPaths: ["app/Palette.tsx", "app/App.tsx"] });
  assert.equal(gate.allowed, false, "the request named tests and none were written");
  assert.equal(gate.kind, "incomplete_shape");
  assert.match(gate.directive, /no test file/i);
});

await test("…and IS done once the test file exists", async () => {
  const c = createTaskController({ task: "implement a command palette and add tests" });
  read("app/App.tsx")(c);
  write("app/Palette.tsx")(c);
  edit("app/App.tsx")(c);
  write("app/Palette.test.ts")(c);
  verify()(c);
  const gate = c.canFinish({ editedPaths: ["app/Palette.tsx", "app/App.tsx", "app/Palette.test.ts"] });
  assert.equal(gate.allowed, true, gate.reason);
  assert.equal(gate.verified, true);
});

await test("a 'wire it up' request is not done when nothing existing was touched", async () => {
  // The classic half-finish: the component exists, nothing imports it.
  const c = createTaskController({ task: "add a command palette and wire it up so Cmd+K opens it" });
  write("app/Palette.tsx")(c);
  write("app/usePalette.ts")(c);
  verify()(c);
  const gate = c.canFinish({ editedPaths: ["app/Palette.tsx", "app/usePalette.ts"] });
  assert.equal(gate.allowed, false, "creating files wires nothing up");
  assert.match(gate.directive, /not reachable|wired up/i);
});

await test("…and IS done once an existing file was modified to use it", async () => {
  const c = createTaskController({ task: "add a command palette and wire it up so Cmd+K opens it" });
  write("app/Palette.tsx")(c);
  edit("app/page.tsx")(c);
  verify()(c);
  const gate = c.canFinish({ editedPaths: ["app/Palette.tsx", "app/page.tsx"] });
  assert.equal(gate.allowed, true, gate.reason);
});

await test("rewriting a file the agent had read counts as integration", async () => {
  // write_file onto an existing, previously-read path is how an agent replaces
  // a module wholesale. Treating that as "created a new file" would accuse it
  // of never wiring anything up.
  const c = createTaskController({ task: "add a palette and wire it into the app" });
  read("app/page.tsx")(c);
  write("app/Palette.tsx")(c);
  write("app/page.tsx")(c);
  verify()(c);
  assert.equal(c.canFinish({ editedPaths: ["app/Palette.tsx", "app/page.tsx"] }).allowed, true);
});

await test("completion is checked even when the agent kept NO todo list", async () => {
  const c = createTaskController({ task: "implement the export flow and wire it into the toolbar" });
  write("app/export.ts")(c);
  verify()(c);
  const gate = c.canFinish({ editedPaths: ["app/export.ts"] });
  assert.equal(gate.allowed, false, "no plan must not mean no completion check");
  assert.equal(c.snapshot().planItemCount, 0, "…and there genuinely was no plan");
});

await test("a ticked-off plan does not exempt a run from the workspace check", async () => {
  // The plan is the agent's own account of its work. An agent that stops
  // early is precisely the one whose plan claims otherwise, so a completed
  // todo list buys no exemption — it is checked against disk like any other.
  const counted = createTaskController({ task: "implement a command palette with wiring" });
  plan(todo("do it", "completed"))(counted);
  read("app/page.tsx")(counted);
  edit("app/page.tsx")(counted);
  verify()(counted);
  assert.equal(counted.canFinish({ editedPaths: ["app/page.tsx"] }).allowed, false,
    "one file for a whole feature is challenged, ticked plan or not");
  assert.equal(counted.canFinish({ editedPaths: ["app/page.tsx"] }).allowed, true,
    "…but only once — a correct agent is not argued with");

  const tested = createTaskController({ task: "implement a command palette with tests" });
  plan(todo("do it", "completed"))(tested);
  edit("app/page.tsx")(tested);
  verify()(tested);
  assert.equal(tested.canFinish({ editedPaths: ["app/page.tsx"] }).allowed, false,
    "ticking a box does not make a missing test file appear");
});

await test("an approved subagent patch is attributed to its real files", async () => {
  // The loop records every file an applied patch touched. Treating that as an
  // anonymous "something changed" switched off every completion check, so the
  // biggest changes in the system were the least scrutinised.
  const c = createTaskController({ task: "add a palette and wire it up with tests" });
  c.recordToolCall({
    tool: "review_patch",
    args: { patch_id: "p1", action: "approve" },
    ok: true,
    output: JSON.stringify({ success: true, applied: true, files: ["app/page.tsx", "app/Palette.tsx"] }),
  });
  verify()(c);
  const snap = c.snapshot();
  assert.ok(snap.editedPaths.includes("app/page.tsx"), "patch files are tracked by path");
  assert.equal(snap.integrationEdits, 2, "applying a patch modifies existing code");

  const gate = c.canFinish({ editedPaths: ["app/page.tsx", "app/Palette.tsx"] });
  assert.equal(gate.allowed, false, "the request asked for tests and the patch had none");
  assert.match(gate.directive, /test file/i);
});

await test("an approved patch with no file list stays unattributable, not accused", async () => {
  const c = createTaskController({ task: "add a palette and wire it up with tests" });
  c.recordToolCall({ tool: "review_patch", args: { patch_id: "p1", action: "approve" }, ok: true,
    output: JSON.stringify({ success: true, applied: true }) });
  verify()(c);
  assert.equal(c.canFinish({ editedPaths: [] }).allowed, true, "no evidence means no accusation");
});

await test("the completion challenge is issued once and cannot trap the run", async () => {
  const c = createTaskController({ task: "implement the export flow and wire it into the toolbar" });
  write("app/export.ts")(c);
  verify()(c);
  assert.equal(c.canFinish({ editedPaths: ["app/export.ts"] }).allowed, false);
  const second = c.canFinish({ editedPaths: ["app/export.ts"] });
  assert.equal(second.allowed, true, "a correct agent must not be argued with forever");
  assert.ok(second.unmet?.length, "…but the run is flagged, not silently blessed");
});

await test("a question is never subject to a completion challenge", async () => {
  const c = createTaskController({ task: "explain how the palette and its tests are wired together" });
  read("app/Palette.tsx")(c);
  assert.equal(c.canFinish({ responseText: "It registers commands and…" }).allowed, true);
});

await test("unattributable changes suppress the check rather than accuse falsely", async () => {
  // bash and apply_patch change files this controller cannot see by path, so
  // the evidence is genuinely missing — staying quiet beats guessing wrong.
  const c = createTaskController({ task: "add a command palette and wire it up with tests" });
  c.recordToolCall({ tool: "bash", args: { command: "mkdir -p app/palette && cp a b" }, ok: true });
  c.recordToolCall({ tool: "apply_patch", args: {}, ok: true });
  verify()(c);
  assert.equal(c.canFinish({ editedPaths: [] }).allowed, true, "no evidence means no accusation");
});

await test("the blocker report names unmet request requirements", async () => {
  const r = run("add a command palette and wire it up with tests",
    Array.from({ length: 10 }, () => editFail("app/page.tsx", "EACCES: permission denied")));
  assert.equal(r.verdict.stop, true);
  const report = r.c.blockerReport();
  assert.match(report, /Stopped early/);
  assert.doesNotMatch(report, /✅|successfully completed/i);
});

console.log("\n══ F. one run, one verdict ═══════════════════════════════════");

await test("a stopped run can never be re-asked into a clean success", async () => {
  // Two components disagreeing about whether the same run succeeded is the
  // worst possible failure here: the controller stopped it, the gate blessed it.
  const c = createTaskController({ task: "fix the type error in a.ts" });
  let v = { stop: false };
  for (let i = 0; i < 20 && !v.stop; i++) {
    edit("a.ts")(c);
    verify("a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.")(c);
    v = c.endIteration();
  }
  assert.equal(v.stop, true);
  const gate = c.canFinish({ editedPaths: ["a.ts"] });
  assert.equal(gate.blocked, true, "the gate must agree the run failed");
  assert.notEqual(gate.verified, true, "and must never mark it verified");
  assert.notEqual(c.stopReason, "verified");
});

await test("a stalled question is not accused of failing to change files", async () => {
  // The uniform wording claimed "no new files" about a run that had read
  // twenty of them. A report the user cannot recognise is not honest.
  const r = run("Explain how the hooks system dispatches events",
    Array.from({ length: 30 }, (_, i) => read(`services/f${i}.mjs`)));
  assert.equal(r.verdict.stop, true, "even a question must be bounded");
  assert.match(r.verdict.detail, /without producing an answer/);
  assert.doesNotMatch(r.verdict.detail, /no new files|change to the workspace/,
    "a question was never asked to change anything");
});

await test("the terminal verdict is idempotent, flags and all", async () => {
  const c = createTaskController({ task: "Add a skeleton component" });
  let gate;
  for (let i = 0; i < 8; i++) gate = c.canFinish({ responseText: "Here is the code you need." });
  assert.equal(gate.allowed, true, "it must terminate, not spin");
  assert.equal(gate.unfulfilled, true, "re-asking must not lose WHY it was not delivered");
});

console.log("\n══ regression: the protections that must survive ═════════════");

await test("isTestPath recognises the conventions without matching ordinary files", async () => {
  for (const p of ["a/b.test.ts", "src/x.spec.tsx", "tests/thing.mjs", "__tests__/x.js", "app/spec/y.ts"]) {
    assert.equal(isTestPath(p), true, p);
  }
  for (const p of ["app/latest.ts", "src/contest.tsx", "lib/inspector.ts", "app/testimonials.tsx"]) {
    assert.equal(isTestPath(p), false, p);
  }
});

await test("the first-pass reprieve still protects real discovery", async () => {
  const r = run("resume the partial command palette implementation", [
    read("app/App.tsx"), read("app/App.tsx"), read("app/App.tsx"), read("app/App.tsx"),
  ]);
  assert.equal(r.verdict.stop, false, "the first stall must still buy a directive, not a stop");
  assert.equal(r.snapshot.discoveryGraceUsed, true);
});

await test("verification gating still holds for every action shape", async () => {
  for (const task of ["fix the typo in Header.tsx", "resume the partial palette", "refactor the reducer"]) {
    const c = createTaskController({ task });
    read("a.ts")(c);
    edit("a.ts")(c);
    assert.equal(c.canFinish({ editedPaths: ["a.ts"] }).allowed, false, `${task} finished unverified`);
  }
});

await test("no shape can be made to run past its own iteration ceiling", async () => {
  const r = run("refactor the reducer across the codebase",
    Array.from({ length: 200 }, (_, i) => write(`src/f${i}.ts`)));
  assert.equal(r.verdict.stop, true);
  assert.ok(r.turnsRun <= budgetFor("refactor").maxIterations, `ran ${r.turnsRun} turns`);
});

console.log("\n══ G. robustness ═════════════════════════════════════════════");

await test("verification outcome trusts the exit code over the prose", async () => {
  const P = (o) => JSON.stringify(o);
  const cases = [
    ["exit 0 despite scary words", true, P({ success: true, exit_code: 0, stdout: "FAILED to warn: 0 errors" }), true],
    ["exit 1 despite happy words", false, P({ success: false, exit_code: 1, stdout: "all good" }), false],
    ["a timeout is never a pass", true, P({ success: true, exit_code: 0, timed_out: true }), false],
    ["spawn error, no exit code", false, P({ success: false, exit_code: null, stderr: "spawn ENOENT" }), false],
    ["verify_ui reports itself", true, P({ success: true, passed: true }), true],
    ["verify_ui failure", true, P({ success: true, passed: false }), false],
    ["truncated payload falls back to text", true, '{"success":true,"exit_code":0,"stdout":"ok"...[truncated]"}', true],
    ["raw jest summary", true, "Test Suites: 3 passed, 3 total", true],
    ["raw pytest summary", true, "===== 5 passed, 0 failed in 1.2s =====", true],
    ["raw eslint clean", true, "✔ 0 problems (0 errors, 0 warnings)", true],
    ["raw shouted FAIL", true, "FAIL src/a.test.ts", false],
    ["raw counted errors", true, "Found 2 errors in 1 file.", false],
  ];
  for (const [label, ok, output, want] of cases) {
    assert.equal(verificationOutcome(ok, output).passed, want, label);
  }
});

await test("classification is total and deterministic for any input", async () => {
  for (const t of ["", "   ", "?", "fix", "implement", "explain",
                   "FIX THE TYPO IN HEADER.TSX", "resume\nthe\npalette",
                   "1. add route\n2. add test", "can you please just show me the code?"]) {
    const a = classifyTask(t);
    assert.deepEqual(a, classifyTask(t), `not deterministic for ${JSON.stringify(t)}`);
    assert.ok(TASK_SHAPES.includes(a.shape), `no shape for ${JSON.stringify(t)}`);
    assert.equal(typeof a.requiresMutation, "boolean");
  }
});

await test("no malformed tool call can crash the controller", async () => {
  // The controller sits on the hot path of every run. A throw here takes down
  // a task that was otherwise fine, so it must survive anything the loop can
  // hand it — including a tool that failed before producing a sane result.
  const c = createTaskController({ task: "add a thing" });
  for (const w of [
    { tool: "read_file" }, { tool: "bash", args: null }, { tool: "write_file", args: { path: null } },
    { tool: "edit_file", args: { path: {} }, ok: false, output: null }, { tool: undefined, args: {} },
    { tool: "todo_write", args: { todos: "not an array" } },
    { tool: "review_patch", args: { action: "approve" }, ok: true, output: "not json" },
    { tool: "bash", args: { command: "npm test" }, ok: true, output: undefined },
    { tool: "grep", args: { pattern: "" }, ok: true }, {},
  ]) {
    c.recordToolCall(w);
    c.endIteration();
    c.canFinish({});
    c.snapshot();
    c.blockerReport();
  }
});

await test("every shape terminates within its own ceiling", async () => {
  // No task shape may be talked into running forever, and none may exceed the
  // budget it declares — the quota guarantee is only as good as the weakest one.
  for (const task of ["explain the router", "fix a.ts", "resume the palette",
                      "add tests for the parser", "refactor the reducer",
                      "implement a feature with tests"]) {
    const c = createTaskController({ task });
    let n = 0, v = { stop: false };
    while (!v.stop && n < 500) { n++; read("same.ts")(c); v = c.endIteration(); }
    assert.equal(v.stop, true, `"${task}" never stopped`);
    assert.ok(n <= c.budget.maxIterations, `"${task}" ran ${n} turns, ceiling ${c.budget.maxIterations}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
