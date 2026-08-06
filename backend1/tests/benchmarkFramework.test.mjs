/**
 * tests/benchmarkFramework.test.mjs
 * Run with: node tests/benchmarkFramework.test.mjs
 *
 * Tests the benchmark framework itself — offline, no API key, no billed calls.
 *
 * A benchmark suite is a measuring instrument, and an instrument that reads
 * "pass" when the work was not done is worse than no instrument at all: it
 * launders a regression into a green check. So most of what is asserted here
 * is the framework REFUSING to award success — to a run that claimed it, to a
 * run that did half the work, and to a run that could not be evaluated at all.
 */

import assert from "assert";
import fs from "fs/promises";
import path from "path";
import os from "os";

import { scoreRun, summarize, claimedSuccess, endedEarly } from "../bench/scoring.mjs";
import { createRecorder } from "../bench/recorder.mjs";
import { snapshotWorkspace, diffSnapshots, createWorkspace, destroyWorkspace } from "../bench/workspace.mjs";
import { runValidator, normalizeChecks, createValidatorHelpers } from "../bench/validators.mjs";
import { loadCorpus, selectBenchmarks } from "../bench/corpus.mjs";
import { compareReports } from "../bench/compare.mjs";
import { benchmarksRoot } from "../bench/paths.mjs";
// The controller's own vocabulary, so scoring can be checked against the real
// thing rather than a copy of it. Deliberately the only agent-side import here:
// this suite must stay runnable with no API key, since importing the graph
// pulls in a provider client that is constructed at module load.
import { STOP_REASONS } from "../services/taskController.mjs";

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

const critical = (name, pass) => ({ name, pass, detail: "", critical: true, guard: false });
const optional = (name, pass) => ({ name, pass, detail: "", critical: false, guard: false });
/** A regression guard: already true before the run, so passing it is not progress. */
const guard = (name, pass) => ({ name, pass, detail: "", critical: true, guard: true });

async function tmpdir(prefix = "kodo-bench-test-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// ══ scoring: outcomes ═══════════════════════════════════════════════════════
console.log("\n══ SCORING: every outcome is reachable and distinct ══════════");

await test("all critical checks passing is the only route to `pass`", async () => {
  const r = scoreRun({ checks: [critical("a", true), critical("b", true)] });
  assert.strictEqual(r.outcome, "pass");
  assert.strictEqual(r.score, 1);
});

await test("one failing critical check is never a pass", async () => {
  const r = scoreRun({ checks: [critical("a", true), critical("b", false)] });
  assert.notStrictEqual(r.outcome, "pass");
  assert.strictEqual(r.outcome, "partial");
});

await test("a partial run is not mistaken for a pass", async () => {
  // Three of four criticals done. Real progress, but the task is not finished.
  const r = scoreRun({
    checks: [critical("a", true), critical("b", true), critical("c", true), critical("d", false)],
  });
  assert.strictEqual(r.outcome, "partial");
  assert.ok(r.score < 1, "a partial run must not score 1");
  assert.deepStrictEqual(r.failedChecks, ["d"]);
});

await test("a failure is not mistaken for a success", async () => {
  const r = scoreRun({ checks: [critical("a", false), critical("b", false)] });
  assert.strictEqual(r.outcome, "fail");
  assert.strictEqual(r.score, 0);
});

await test("optional checks can never decide pass or fail on their own", async () => {
  const allCriticalsPass = scoreRun({ checks: [critical("a", true), optional("style", false)] });
  assert.strictEqual(allCriticalsPass.outcome, "pass", "a failing optional check must not block a pass");
  assert.ok(allCriticalsPass.score < 1, "…but it should still cost score");

  const noCriticalsPass = scoreRun({ checks: [critical("a", false), optional("style", true)] });
  assert.strictEqual(noCriticalsPass.outcome, "fail", "a passing optional check must not rescue a failure");
});

await test("achieving nothing after asking the user reads as needs_user, not fail", async () => {
  const r = scoreRun({ checks: [critical("a", false)], askUserCalls: 1 });
  assert.strictEqual(r.outcome, "needs_user");
});

await test("achieving nothing after giving up early reads as stopped_early", async () => {
  const r = scoreRun({
    checks: [critical("a", false)],
    metrics: { controller: { stopReason: "no_progress" } },
  });
  assert.strictEqual(r.outcome, "stopped_early");
});

await test("real progress outranks the reason for stopping — partial beats stopped_early", async () => {
  // Reporting this as `stopped_early` would hide that half the task landed.
  const r = scoreRun({
    checks: [critical("a", true), critical("b", false)],
    metrics: { controller: { stopReason: "thrashing" } },
    askUserCalls: 3,
  });
  assert.strictEqual(r.outcome, "partial");
});

await test("a run that did nothing is a fail, not a partial, however many guards it satisfies", async () => {
  // The exact shape of a no-op run: every "is the fixture still intact" check
  // passes trivially, and nothing the task asked for happened.
  const r = scoreRun({
    checks: [
      guard("the module still loads", true),
      guard("the existing route still works", true),
      guard("unknown routes still 404", true),
      critical("the new endpoint responds", false),
      critical("it was wired into the route table", false),
    ],
  });
  assert.strictEqual(r.outcome, "fail", "satisfying guards is not progress — a no-op must not be dressed up as partial");
  assert.strictEqual(r.progressPassed, 0);
  assert.strictEqual(r.progressTotal, 2);
});

await test("guards still have to hold — breaking one costs the pass", async () => {
  const r = scoreRun({
    checks: [guard("the existing route still works", false), critical("the new endpoint responds", true)],
  });
  assert.notStrictEqual(r.outcome, "pass", "a run that completed the task by breaking something else has not passed");
  assert.strictEqual(r.outcome, "partial");
});

await test("real progress plus intact guards is a pass", async () => {
  const r = scoreRun({
    checks: [guard("the existing route still works", true), critical("the new endpoint responds", true)],
  });
  assert.strictEqual(r.outcome, "pass");
});

await test("a no-op that gave up early is stopped_early, not partial", async () => {
  const r = scoreRun({
    checks: [guard("nothing was broken", true), critical("the rename happened", false)],
    metrics: { controller: { stopReason: "blocked" } },
  });
  assert.strictEqual(r.outcome, "stopped_early");
});

await test("a validator that asserts nothing cannot yield a pass", async () => {
  const r = scoreRun({ checks: [] });
  assert.notStrictEqual(r.outcome, "pass");
  assert.strictEqual(r.outcome, "fail");
});

// ══ scoring: blockers ═══════════════════════════════════════════════════════
console.log("\n══ SCORING: blockers are reported honestly ═══════════════════");

await test("a blocked run is never counted as a pass", async () => {
  // Even with every check somehow passing, an un-evaluatable run is not a pass.
  const r = scoreRun({
    checks: [critical("a", true), critical("b", true)],
    blocker: { stage: "preflight", message: "no API key" },
  });
  assert.strictEqual(r.outcome, "blocked");
});

await test("a blocked run is not hidden behind a generic failure", async () => {
  const r = scoreRun({ checks: [], blocker: { stage: "validator_run", message: "validator threw: boom" } });
  assert.strictEqual(r.outcome, "blocked", "must be distinguishable from `fail`");
});

await test("blocked runs drag the success rate down and are counted separately", async () => {
  const s = summarize([
    { outcome: "pass", score: 1, metrics: { iterations: 3 }, usage: { inputTokens: 10, outputTokens: 5 }, durationMs: 1000 },
    { outcome: "blocked", score: 0, metrics: null, usage: null, durationMs: 5 },
  ]);
  assert.strictEqual(s.successRate, 0.5, "a blocked benchmark must not be excluded from the denominator");
  assert.strictEqual(s.blockedRate, 0.5);
  assert.strictEqual(s.counts.blocked, 1);
  // …but it must not poison the averages, since it produced no agent metrics.
  assert.strictEqual(s.avgIterations, 3);
});

// ══ scoring: false positives ════════════════════════════════════════════════
console.log("\n══ SCORING: false-positive success claims ════════════════════");

await test("claiming success while failing is flagged as a false positive", async () => {
  const r = scoreRun({
    checks: [critical("the file exists", false)],
    finalAnswer: "I've implemented the helper and wired it up. All done.",
  });
  assert.strictEqual(r.outcome, "fail");
  assert.strictEqual(r.claimedSuccess, true);
  assert.strictEqual(r.falsePositive, true, "an untrue success claim is the signal this system exists to surface");
});

await test("an honestly hedged report is not a false positive", async () => {
  const r = scoreRun({
    checks: [critical("the file exists", false)],
    finalAnswer: "I added the helper but could not verify it — treat it as unverified.",
  });
  assert.strictEqual(r.claimedSuccess, false);
  assert.strictEqual(r.falsePositive, false);
});

await test("a true success claim is not a false positive", async () => {
  const r = scoreRun({
    checks: [critical("a", true)],
    finalAnswer: "I've implemented it and the tests pass.",
  });
  assert.strictEqual(r.outcome, "pass");
  assert.strictEqual(r.falsePositive, false);
});

await test("the controller reaching `verified` counts as a success claim", async () => {
  assert.strictEqual(
    claimedSuccess({ finalAnswer: "here you go", metrics: { controller: { stopReason: "verified" } } }),
    true
  );
});

await test("falsePositiveSuccessRate is over claims made, not over all runs", async () => {
  const s = summarize([
    { outcome: "fail", score: 0, claimedSuccess: true, falsePositive: true, metrics: {}, durationMs: 1 },
    { outcome: "pass", score: 1, claimedSuccess: true, falsePositive: false, metrics: {}, durationMs: 1 },
    { outcome: "fail", score: 0, claimedSuccess: false, falsePositive: false, metrics: {}, durationMs: 1 },
  ]);
  assert.strictEqual(s.claimedSuccessCount, 2);
  assert.strictEqual(s.falsePositiveCount, 1);
  assert.strictEqual(s.falsePositiveSuccessRate, 0.5);
});

await test("verificationSuccessRate counts only runs that verified something", async () => {
  const s = summarize([
    { outcome: "pass", score: 1, durationMs: 1, metrics: { controller: { verificationRan: true, verificationCurrent: true } } },
    { outcome: "fail", score: 0, durationMs: 1, metrics: { controller: { verificationRan: true, verificationCurrent: false } } },
    { outcome: "pass", score: 1, durationMs: 1, metrics: { controller: { verificationRan: false } } },
  ]);
  assert.strictEqual(s.verificationRunCount, 2, "the run that verified nothing must not be in the denominator");
  assert.strictEqual(s.verificationSuccessRate, 0.5);
});

await test("a verification that passed and then went stale does not count as verified", async () => {
  const s = summarize([
    // Ran, passed, but files changed afterwards — it no longer describes the tree.
    { outcome: "pass", score: 1, durationMs: 1, metrics: { controller: { verificationRan: true, verificationPassed: true, verificationCurrent: false, verificationStale: true } } },
  ]);
  assert.strictEqual(s.verificationSuccessRate, 0);
});

// ══ scoring: determinism ════════════════════════════════════════════════════
console.log("\n══ SCORING: determinism ══════════════════════════════════════");

await test("identical inputs always produce byte-identical scores", async () => {
  const input = {
    checks: [critical("a", true), critical("b", false), optional("c", true)],
    metrics: { iterations: 7, exitReason: "completed", controller: { stopReason: "verified" } },
    askUserCalls: 1,
    finalAnswer: "I have implemented the change.",
  };
  const first = JSON.stringify(scoreRun(input));
  for (let i = 0; i < 25; i++) {
    assert.strictEqual(JSON.stringify(scoreRun(input)), first, `scoring drifted on repetition ${i}`);
  }
});

await test("summary metrics are stable across repeated aggregation", async () => {
  const results = [
    { outcome: "pass", score: 1, durationMs: 1200, metrics: { iterations: 4 }, usage: { inputTokens: 100, outputTokens: 50 }, counts: { toolCalls: 9 } },
    { outcome: "fail", score: 0, durationMs: 800, metrics: { iterations: 12 }, usage: { inputTokens: 300, outputTokens: 90 }, counts: { toolCalls: 30 } },
  ];
  const first = JSON.stringify(summarize(results));
  for (let i = 0; i < 10; i++) assert.strictEqual(JSON.stringify(summarize(results)), first);
  const s = summarize(results);
  assert.strictEqual(s.avgIterations, 8);
  assert.strictEqual(s.avgTokens, 270);
});

await test("endedEarly recognises every early-stop signal, and nothing else", async () => {
  assert.strictEqual(endedEarly({ stoppedEarly: true }), true);
  assert.strictEqual(endedEarly({ exitReason: "iteration_budget_exhausted" }), true);
  assert.strictEqual(endedEarly({ exitReason: "cancelled" }), true);
  assert.strictEqual(endedEarly({ controller: { stopReason: "thrashing" } }), true);
  assert.strictEqual(endedEarly({ controller: { stopReason: "blocked" } }), true);
  assert.strictEqual(endedEarly({ exitReason: "completed", controller: { stopReason: "verified" } }), false);
  assert.strictEqual(endedEarly(null), false);
});

// ══ the metric hook ═════════════════════════════════════════════════════════
console.log("\n══ METRIC HOOK: the agent's telemetry reaches the runner ═════");

// The other half of this hook — that the graph declares a channel for
// runMetrics and graph_runner forwards it — is asserted in agent_loop.test.mjs,
// next to the code that produces it, because importing the graph requires
// credentials this suite deliberately does without.

await test("scoring recognises every stop reason the controller can actually produce", async () => {
  // The drift this catches: renaming a STOP_REASON in taskController.mjs while
  // bench/scoring.mjs keeps matching the old string. Nothing would fail — runs
  // that gave up early would just quietly start scoring as `fail` instead of
  // `stopped_early`, and the honest-blocker benchmarks would go red for the
  // wrong reason.
  const earlyStops = [STOP_REASONS.BLOCKED, STOP_REASONS.NO_PROGRESS, STOP_REASONS.THRASHING, STOP_REASONS.BUDGET_EXHAUSTED];
  for (const stopReason of earlyStops) {
    assert.strictEqual(endedEarly({ controller: { stopReason } }), true,
      `bench/scoring.mjs does not recognise the controller's "${stopReason}" as an early stop`);
  }
  assert.strictEqual(endedEarly({ controller: { stopReason: STOP_REASONS.VERIFIED } }), false,
    "a verified run must not be classified as an early stop");
});

await test("a run with no metrics at all still scores, rather than crashing", async () => {
  // Sub-agent runs and early returns produce no controller snapshot.
  const r = scoreRun({ checks: [critical("a", true)], metrics: null });
  assert.strictEqual(r.outcome, "pass");
  assert.strictEqual(summarize([{ ...r, metrics: null, usage: null, durationMs: 5 }]).avgIterations, 0);
});

// ══ workspace measurement ═══════════════════════════════════════════════════
console.log("\n══ WORKSPACE: changes are measured, not claimed ══════════════");

await test("the diff detects additions, modifications and deletions", async () => {
  const dir = await tmpdir();
  try {
    await fs.writeFile(path.join(dir, "keep.txt"), "same");
    await fs.writeFile(path.join(dir, "edit.txt"), "before");
    await fs.writeFile(path.join(dir, "gone.txt"), "bye");
    const before = await snapshotWorkspace(dir);

    await fs.writeFile(path.join(dir, "edit.txt"), "after");
    await fs.rm(path.join(dir, "gone.txt"));
    await fs.mkdir(path.join(dir, "sub"), { recursive: true });
    await fs.writeFile(path.join(dir, "sub/new.txt"), "hi");
    const after = await snapshotWorkspace(dir);

    const d = diffSnapshots(before, after);
    assert.deepStrictEqual(d.added, ["sub/new.txt"]);
    assert.deepStrictEqual(d.modified, ["edit.txt"]);
    assert.deepStrictEqual(d.deleted, ["gone.txt"]);
    assert.deepStrictEqual(d.changed, ["edit.txt", "gone.txt", "sub/new.txt"]);
  } finally {
    await destroyWorkspace(dir);
  }
});

await test("the agent's own scratch directory is not counted as task output", async () => {
  const dir = await tmpdir();
  try {
    await fs.writeFile(path.join(dir, "real.txt"), "before");
    const before = await snapshotWorkspace(dir);

    await fs.mkdir(path.join(dir, ".kodo/scratch"), { recursive: true });
    await fs.writeFile(path.join(dir, ".kodo/scratch/probe.mjs"), "console.log(1)");
    await fs.writeFile(path.join(dir, "real.txt"), "after");

    const d = diffSnapshots(before, await snapshotWorkspace(dir));
    assert.deepStrictEqual(d.changed, ["real.txt"],
      "throwaway probe scripts are not the agent's answer to the task");
  } finally {
    await destroyWorkspace(dir);
  }
});

await test("a file rewritten with identical content is not reported as changed", async () => {
  const dir = await tmpdir();
  try {
    await fs.writeFile(path.join(dir, "a.txt"), "content");
    const before = await snapshotWorkspace(dir);
    await fs.writeFile(path.join(dir, "a.txt"), "content");
    const d = diffSnapshots(before, await snapshotWorkspace(dir));
    assert.deepStrictEqual(d.changed, [], "content hashing, not mtime — a no-op write is not a change");
  } finally {
    await destroyWorkspace(dir);
  }
});

await test("each workspace is isolated and seeded from the fixture", async () => {
  const fixture = await tmpdir("kodo-bench-fixture-");
  try {
    await fs.writeFile(path.join(fixture, "seed.txt"), "original");
    const benchmark = { id: "x/y", fixtureDir: fixture, metadata: {} };

    const a = await createWorkspace(benchmark);
    const b = await createWorkspace(benchmark);
    try {
      assert.notStrictEqual(a, b, "two runs must not share a workspace");
      await fs.writeFile(path.join(a, "seed.txt"), "mutated by run A");
      assert.strictEqual(await fs.readFile(path.join(b, "seed.txt"), "utf-8"), "original",
        "run A's edits leaked into run B — reruns would not be comparable");
      assert.strictEqual(await fs.readFile(path.join(fixture, "seed.txt"), "utf-8"), "original",
        "the run mutated the corpus fixture itself");
    } finally {
      await destroyWorkspace(a);
      await destroyWorkspace(b);
    }
  } finally {
    await destroyWorkspace(fixture);
  }
});

await test("declared fixture modes are applied, so an unwritable fixture really is unwritable", async () => {
  const fixture = await tmpdir("kodo-bench-fixture-");
  try {
    await fs.writeFile(path.join(fixture, "locked.txt"), "x");
    const ws = await createWorkspace({
      id: "x/y", fixtureDir: fixture, metadata: { fixtureModes: { "locked.txt": "0444" } },
    });
    try {
      const mode = (await fs.stat(path.join(ws, "locked.txt"))).mode & 0o777;
      assert.strictEqual(mode, 0o444);
      await assert.rejects(() => fs.writeFile(path.join(ws, "locked.txt"), "y"));
    } finally {
      await destroyWorkspace(ws);
    }
  } finally {
    await destroyWorkspace(fixture);
  }
});

// ══ transcript capture ══════════════════════════════════════════════════════
console.log("\n══ RECORDER: transcripts are captured for replay ═════════════");

await test("emitted events, tool calls and questions all reach the transcript", async () => {
  const rec = createRecorder();
  rec.emit({ type: "progress", stage: "exploring", message: "looking around" });
  rec.emit({ type: "content", content: "here is my answer" });
  rec.recordEvent({ kind: "user", content: "do the thing" });
  rec.recordEvent({
    kind: "tool", toolCallId: "c1", toolName: "read_file",
    toolArgs: { path: "a.ts" }, content: '{"success":true}', status: "ok", durationMs: 12,
  });
  rec.recordEvent({ kind: "assistant", content: "done", toolCalls: null });
  await rec.askUser({ question: "which file?", header: "Ambiguous" });

  assert.strictEqual(rec.transcript.length, 6, "every event must be recorded");
  assert.strictEqual(rec.streamedContent, "here is my answer");
  assert.ok(rec.transcript.every((e, i) => e.seq === i), "events must carry a monotonic sequence for ordering");
  assert.ok(rec.transcript.every((e) => typeof e.tMs === "number"), "events must be timestamped relative to the run");
});

await test("the tool timeline keeps arguments, status, duration and output", async () => {
  const rec = createRecorder();
  rec.recordEvent({ kind: "tool", toolCallId: "c1", toolName: "edit_file", toolArgs: { path: "a.ts" }, content: '{"success":true}', status: "ok", durationMs: 40 });
  rec.recordEvent({ kind: "tool", toolCallId: "c2", toolName: "bash", toolArgs: { command: "npm test" }, content: '{"success":false,"error":"1 failing"}', status: "error", durationMs: 900 });

  assert.strictEqual(rec.timeline.length, 2);
  const [edit, bash] = rec.timeline;
  assert.strictEqual(edit.toolName, "edit_file");
  assert.deepStrictEqual(bash.args, { command: "npm test" });
  assert.strictEqual(bash.status, "error");
  assert.strictEqual(bash.durationMs, 900);
  assert.match(bash.output, /1 failing/, "tool OUTPUT must survive — a timeline without it cannot debug a failure");

  const s = rec.summary();
  assert.strictEqual(s.toolCalls, 2);
  assert.strictEqual(s.failedToolCalls, 1);
  assert.deepStrictEqual(s.toolCallsByName, { bash: 1, edit_file: 1 });
});

await test("ask_user answers are recorded alongside the question", async () => {
  const rec = createRecorder({ answerQuestion: () => "use the second one" });
  const answer = await rec.askUser({ question: "which?" });
  assert.strictEqual(answer, "use the second one");
  assert.strictEqual(rec.askUserCalls.length, 1);
  assert.strictEqual(rec.askUserCalls[0].answer, "use the second one",
    "a replay must show what the agent was told, not just what it asked");
});

await test("a run that never asks anything records no questions", async () => {
  const rec = createRecorder();
  assert.strictEqual(rec.summary().askUserCalls, 0);
});

await test("oversized tool output is truncated rather than dropped", async () => {
  const rec = createRecorder();
  rec.recordEvent({ kind: "tool", toolName: "bash", toolArgs: {}, content: "x".repeat(80_000), status: "ok" });
  const out = rec.timeline[0].output;
  assert.ok(out.length < 80_000, "huge output must be capped");
  assert.match(out, /truncated/, "…and the truncation must be visible, not silent");
});

// ══ validators ══════════════════════════════════════════════════════════════
console.log("\n══ VALIDATORS: workspace is the source of truth ══════════════");

async function withValidator(source, fn) {
  const dir = await tmpdir("kodo-bench-validator-");
  try {
    const file = path.join(dir, "validator.mjs");
    await fs.writeFile(file, source, "utf-8");
    return await fn({ validatorPath: file, dir });
  } finally {
    await destroyWorkspace(dir);
  }
}

await test("a validator that throws is a blocker, not a failure", async () => {
  await withValidator(`export default async function () { throw new Error("tsc is not installed"); }`, async (b) => {
    const { checks, blocker } = await runValidator(b, { workspace: b.dir, run: {} });
    assert.deepStrictEqual(checks, []);
    assert.strictEqual(blocker.stage, "validator_run");
    assert.match(blocker.message, /tsc is not installed/, "the real reason must survive to the report");
    assert.strictEqual(scoreRun({ checks, blocker }).outcome, "blocked");
  });
});

await test("a validator with no critical checks is rejected instead of passing vacuously", async () => {
  await withValidator(
    `export default async () => [{ name: "style", pass: true, critical: false }];`,
    async (b) => {
      const { blocker } = await runValidator(b, { workspace: b.dir, run: {} });
      assert.ok(blocker, "a validator that cannot establish success must say so");
      assert.match(blocker.message, /no critical non-guard checks/);
    }
  );
});

await test("a validator made only of guards is rejected — guards prove no work was done", async () => {
  await withValidator(
    `export default async () => [{ name: "the fixture still parses", pass: true, guard: true }];`,
    async (b) => {
      const { blocker } = await runValidator(b, { workspace: b.dir, run: {} });
      assert.ok(blocker, "an agent that does nothing satisfies every guard — that cannot be a pass");
    }
  );
});

await test("a malformed check is caught rather than silently coerced", async () => {
  await withValidator(`export default async () => [{ name: "x", pass: "yes" }];`, async (b) => {
    const { blocker } = await runValidator(b, { workspace: b.dir, run: {} });
    assert.ok(blocker, 'pass: "yes" is not a boolean and must not be treated as one');
  });
});

await test("a validator reads the real workspace, so an agent's claim cannot fake a pass", async () => {
  await withValidator(
    `export default async ({ helpers }) => [{ name: "output.txt exists", pass: await helpers.exists("output.txt") }];`,
    async (b) => {
      // The agent insists it is done. Nothing is on disk.
      const lying = await runValidator(b, {
        workspace: b.dir,
        run: { finalAnswer: "I've created output.txt and verified it. All done." },
      });
      const lyingScore = scoreRun({ ...lying, finalAnswer: "I've created output.txt and verified it. All done." });
      assert.strictEqual(lyingScore.outcome, "fail", "the workspace, not the summary, decides");
      assert.strictEqual(lyingScore.falsePositive, true);

      // Now actually do the work.
      await fs.writeFile(path.join(b.dir, "output.txt"), "real");
      const honest = await runValidator(b, { workspace: b.dir, run: {} });
      assert.strictEqual(scoreRun(honest).outcome, "pass");
    }
  );
});

await test("validator helpers cannot be pointed outside the workspace", async () => {
  const dir = await tmpdir();
  try {
    const helpers = createValidatorHelpers(dir);
    assert.throws(() => helpers.resolve("../../etc/passwd"), /escapes the workspace/);
  } finally {
    await destroyWorkspace(dir);
  }
});

await test("helpers.run() executes a real command in the workspace", async () => {
  const dir = await tmpdir();
  try {
    await fs.writeFile(path.join(dir, "ok.mjs"), `process.exit(0);`);
    await fs.writeFile(path.join(dir, "bad.mjs"), `process.exit(3);`);
    const helpers = createValidatorHelpers(dir);
    assert.strictEqual((await helpers.run("node ok.mjs")).ok, true);
    const bad = await helpers.run("node bad.mjs");
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.code, 3);
  } finally {
    await destroyWorkspace(dir);
  }
});

await test("normalizeChecks defaults checks to critical", async () => {
  const [c] = normalizeChecks([{ name: "a", pass: true }]);
  assert.strictEqual(c.critical, true, "a check must be load-bearing unless it opts out");
});

// ══ corpus ══════════════════════════════════════════════════════════════════
console.log("\n══ CORPUS: the real benchmark set is well-formed ═════════════");

const corpus = await loadCorpus({ root: benchmarksRoot });

await test("every benchmark in the repo loads and is valid", async () => {
  const invalid = corpus.filter((b) => !b.valid);
  assert.deepStrictEqual(invalid.map((b) => `${b.id}: ${b.reason}`), [], "invalid benchmarks found");
  assert.ok(corpus.length >= 10, `expected a real corpus, found ${corpus.length}`);
});

await test("a malformed benchmark surfaces as invalid rather than being skipped", async () => {
  const root = await tmpdir("kodo-bench-corpus-");
  try {
    const dir = path.join(root, "fam", "broken");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "prompt.md"), "do a thing");
    await fs.writeFile(path.join(dir, "expected.md"), "a thing is done");
    await fs.writeFile(path.join(dir, "metadata.json"), JSON.stringify({ title: "t", difficulty: "medium", golden: true, capabilities: ["implementation"] }));
    await fs.writeFile(path.join(dir, "validator.mjs"), "export default async () => [];");

    const loaded = await loadCorpus({ root });
    assert.strictEqual(loaded.length, 1, "a broken benchmark must still appear — silently dropping it hides the gap");
    assert.strictEqual(loaded[0].valid, false);
    assert.match(loaded[0].reason, /difficulty/);
  } finally {
    await destroyWorkspace(root);
  }
});

await test("a benchmark missing its validator is invalid", async () => {
  const root = await tmpdir("kodo-bench-corpus-");
  try {
    const dir = path.join(root, "fam", "novalidator");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "prompt.md"), "x");
    await fs.writeFile(path.join(dir, "expected.md"), "y");
    await fs.writeFile(path.join(dir, "metadata.json"), JSON.stringify({ title: "t", difficulty: "easy", golden: false, capabilities: ["implementation"] }));
    const loaded = await loadCorpus({ root });
    assert.strictEqual(loaded[0].valid, false);
    assert.match(loaded[0].reason, /validator/);
  } finally {
    await destroyWorkspace(root);
  }
});

await test("the corpus covers every behaviour the suite claims to test", async () => {
  const seen = new Set(corpus.flatMap((b) => b.metadata.capabilities));
  const required = [
    "implementation", "resume", "verification", "no_progress", "thrashing",
    "honest_blocker", "multi_file", "single_file", "question_only", "wiring",
  ];
  const missing = required.filter((c) => !seen.has(c));
  assert.deepStrictEqual(missing, [], `no benchmark exercises: ${missing.join(", ")}`);
});

await test("the corpus contains both easy and hard tasks, and a golden set", async () => {
  assert.ok(corpus.some((b) => b.metadata.difficulty === "easy"), "no easy tasks");
  assert.ok(corpus.some((b) => b.metadata.difficulty === "hard"), "no hard tasks");
  assert.ok(corpus.filter((b) => b.metadata.golden).length >= 5, "the golden regression set is too small to protect anything");
});

await test("benchmarks load in a stable order, so runs stay comparable", async () => {
  const ids = corpus.map((b) => b.id);
  assert.deepStrictEqual(ids, [...ids].sort(), "corpus order must be deterministic");
  const again = (await loadCorpus({ root: benchmarksRoot })).map((b) => b.id);
  assert.deepStrictEqual(again, ids);
});

await test("selection filters narrow, and an unknown id is an error, not an empty run", async () => {
  assert.ok(selectBenchmarks(corpus, { golden: true }).every((b) => b.metadata.golden));
  assert.ok(selectBenchmarks(corpus, { families: ["debug"] }).every((b) => b.family === "debug"));
  assert.ok(selectBenchmarks(corpus, { capabilities: ["thrashing"] }).length > 0);
  assert.throws(
    () => selectBenchmarks(corpus, { ids: ["frontend/typo-in-the-id"] }),
    /Unknown benchmark id/,
    "a typo'd --id must fail loudly rather than run nothing and report success"
  );
});

// ══ comparison ══════════════════════════════════════════════════════════════
console.log("\n══ COMPARISON: regressions are obvious ═══════════════════════");

const report = (runId, results, summary = {}) => ({
  version: 1, runId, label: "", environment: { gitBranch: "main" },
  summary: { successRate: 0, partialRate: 0, failureRate: 0, blockedRate: 0, avgIterations: 0, avgTokens: 0, avgDurationMs: 0, verificationSuccessRate: 0, falsePositiveSuccessRate: 0, avgScore: 0, ...summary },
  results,
});
const res = (id, outcome, extra = {}) => ({ benchmarkId: id, family: id.split("/")[0], outcome, score: outcome === "pass" ? 1 : 0, failedChecks: [], golden: false, blocker: null, ...extra });

await test("a pass that became a failure is reported as a regression", async () => {
  const cmp = compareReports(
    report("base", [res("a/one", "pass"), res("a/two", "pass")]),
    report("curr", [res("a/one", "pass"), res("a/two", "fail", { failedChecks: ["wires it up"] })])
  );
  assert.strictEqual(cmp.hasRegressions, true);
  assert.strictEqual(cmp.regressions.length, 1);
  assert.strictEqual(cmp.regressions[0].benchmarkId, "a/two");
  assert.deepStrictEqual(cmp.regressions[0].newlyFailingChecks, ["wires it up"],
    "the specific check that broke is what makes a regression actionable");
});

await test("a pass that became a partial is still a regression", async () => {
  const cmp = compareReports(report("b", [res("a/one", "pass")]), report("c", [res("a/one", "partial")]));
  assert.strictEqual(cmp.hasRegressions, true);
});

await test("a pass that became blocked is a regression, not an improvement", async () => {
  const cmp = compareReports(report("b", [res("a/one", "pass")]), report("c", [res("a/one", "blocked")]));
  assert.strictEqual(cmp.regressions.length, 1, "losing the ability to evaluate a benchmark is a regression");
  assert.strictEqual(cmp.improvements.length, 0);
});

await test("a regression on a golden benchmark is called out separately", async () => {
  const cmp = compareReports(
    report("b", [res("g/one", "pass", { golden: true }), res("n/two", "pass")]),
    report("c", [res("g/one", "fail", { golden: true }), res("n/two", "fail")])
  );
  assert.strictEqual(cmp.regressions.length, 2);
  assert.strictEqual(cmp.goldenRegressions.length, 1);
  assert.strictEqual(cmp.goldenRegressions[0].benchmarkId, "g/one");
});

await test("improvements, additions and removals are all tracked", async () => {
  const cmp = compareReports(
    report("b", [res("a/one", "fail"), res("a/gone", "pass")]),
    report("c", [res("a/one", "pass"), res("a/new", "pass")])
  );
  assert.strictEqual(cmp.hasRegressions, false);
  assert.deepStrictEqual(cmp.improvements.map((i) => i.benchmarkId), ["a/one"]);
  assert.deepStrictEqual(cmp.added.map((i) => i.benchmarkId), ["a/new"]);
  assert.deepStrictEqual(cmp.removed.map((i) => i.benchmarkId), ["a/gone"]);
});

await test("with repeats, a benchmark is judged by its worst attempt", async () => {
  const cmp = compareReports(
    report("b", [res("a/one", "pass")]),
    report("c", [{ ...res("a/one", "pass"), repeat: 1 }, { ...res("a/one", "fail"), repeat: 2 }])
  );
  assert.strictEqual(cmp.hasRegressions, true, "a benchmark that passes only sometimes has regressed");
});

await test("metric deltas are computed in both directions", async () => {
  const cmp = compareReports(
    report("b", [res("a/one", "pass")], { successRate: 1, avgTokens: 1000 }),
    report("c", [res("a/one", "fail")], { successRate: 0.5, avgTokens: 1500 })
  );
  assert.strictEqual(cmp.metricDeltas.successRate.delta, -0.5);
  assert.strictEqual(cmp.metricDeltas.avgTokens.delta, 500);
});

// ══ summary ═════════════════════════════════════════════════════════════════
console.log(`\n${"═".repeat(62)}`);
console.log(`  benchmark framework: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(62)}\n`);
process.exit(failed === 0 ? 0 : 1);
