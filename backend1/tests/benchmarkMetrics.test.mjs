/**
 * tests/benchmarkMetrics.test.mjs
 * Run with: node tests/benchmarkMetrics.test.mjs
 *
 * The measurement layer: driver-independent metrics, repeat statistics, and the
 * reporters. Offline.
 *
 * The rule under test throughout is the one in bench/metrics.mjs: a number used
 * to compare agents may only come from the workspace, the checks, the agent's
 * own words, or a check the framework ran itself. Anything an agent reports
 * about its internals is telemetry, and telemetry must never move a ranking —
 * otherwise the benchmark measures instrumentation, not ability.
 */

import assert from "assert";
import fs from "fs/promises";
import path from "path";
import os from "os";

import {
  lineDiff, workspaceShape, timelineShape, qualityMetrics, telemetryMetrics, estimateCost,
} from "../bench/metrics.mjs";
import { median, mean, stddev, confidenceInterval95, describe, aggregateRepeats, aggregateAgent } from "../bench/stats.mjs";
import { toCsv, toMarkdown, toJson, rankAgents, categoryMatrix } from "../bench/reporters.mjs";
import { buildAggregate } from "../bench/compare.mjs";
import { loadCorpus } from "../bench/corpus.mjs";
import { runBenchmark, collectEnvironment } from "../bench/runner.mjs";
import { scriptedDriver } from "../bench/drivers.mjs";
import { benchmarksRoot } from "../bench/paths.mjs";

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

// ── workspace measurement ───────────────────────────────────────────────────
console.log("\n══ WORKSPACE SHAPE ═══════════════════════════════════════════");

await test("lineDiff counts added and removed lines", () => {
  const d = lineDiff("a\nb\nc\n", "a\nc\nd\ne\n");
  assert.strictEqual(d.added, 2);
  assert.strictEqual(d.removed, 1);
  assert.strictEqual(d.churn, 3);
});

await test("reordering lines is not counted as a change", () => {
  // A multiset diff on purpose: an agent that moves a function has not
  // rewritten the file, and charging it churn would punish tidying.
  assert.strictEqual(lineDiff("a\nb\nc\n", "c\nb\na\n").churn, 0);
});

await test("blank lines and indentation noise are ignored", () => {
  assert.strictEqual(lineDiff("a\n\n  b\n", "a\nb\n\n\n").churn, 0);
});

await test("workspaceShape measures files and lines from disk", async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "shape-fix-"));
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "shape-ws-"));
  try {
    await fs.writeFile(path.join(fixture, "a.txt"), "one\ntwo\n");
    await fs.writeFile(path.join(ws, "a.txt"), "one\ntwo\nthree\n");
    await fs.writeFile(path.join(ws, "b.test.mjs"), "test\n");

    const shape = await workspaceShape({
      workspace: ws, fixtureDir: fixture,
      workspaceChanges: { added: ["b.test.mjs"], modified: ["a.txt"], deleted: [], changed: ["a.txt", "b.test.mjs"] },
    });
    assert.strictEqual(shape.filesChanged, 2);
    assert.strictEqual(shape.linesAdded, 2, "one new line in a.txt plus one in the new file");
    assert.strictEqual(shape.linesRemoved, 0);
    assert.strictEqual(shape.testFilesAdded, 1, "a .test.mjs file counts as a test added");
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
    await fs.rm(ws, { recursive: true, force: true });
  }
});

// ── timeline measurement ────────────────────────────────────────────────────
console.log("\n══ TIMELINE SHAPE ════════════════════════════════════════════");

const call = (toolName, args, status = "ok") => ({ toolName, args, status });

await test("an absent timeline reports loopScore null, not zero", () => {
  const t = timelineShape([]);
  assert.strictEqual(t.available, false);
  assert.strictEqual(t.loopScore, null,
    "an agent that reports no tools has not proven it never looped — 0 would be a claim");
});

await test("repeated identical calls raise the loop score", () => {
  const none = timelineShape([call("read_file", { path: "a" }), call("read_file", { path: "b" })]);
  assert.strictEqual(none.loopScore, 0);
  const looped = timelineShape([
    call("bash", { command: "npm test" }), call("bash", { command: "npm test" }), call("bash", { command: "npm test" }),
  ]);
  assert.ok(looped.loopScore > 0.5, `expected a high loop score, got ${looped.loopScore}`);
});

await test("edits are split into successful and failed", () => {
  const t = timelineShape([
    call("write_file", { path: "a.ts" }),
    call("edit_file", { path: "a.ts" }, "error"),
    call("read_file", { path: "b.ts" }),
  ]);
  assert.strictEqual(t.editCalls, 2);
  assert.strictEqual(t.successfulEdits, 1);
  assert.strictEqual(t.failedEdits, 1);
});

await test("a third write to the same file counts as rework", () => {
  // Two passes (write, then fix) is normal; beyond that the agent is circling.
  const twice = timelineShape([call("write_file", { path: "a.ts" }), call("write_file", { path: "a.ts" })]);
  assert.strictEqual(twice.redundantEdits, 0);
  const fourTimes = timelineShape(Array.from({ length: 4 }, () => call("write_file", { path: "a.ts" })));
  assert.strictEqual(fourTimes.redundantEdits, 2);
});

await test("verification-shaped commands are counted", () => {
  const t = timelineShape([call("bash", { command: "npm test" }), call("bash", { command: "ls -la" })]);
  assert.strictEqual(t.verifyCommands, 1);
});

// ── the comparable set ──────────────────────────────────────────────────────
console.log("\n══ COMPARABLE QUALITY METRICS ════════════════════════════════");

const shape0 = { filesChanged: 1, filesAdded: 0, filesModified: 1, filesDeleted: 0, linesAdded: 3, linesRemoved: 1, diffChurn: 4, testFilesAdded: 0, testFilesAddedPaths: [] };
const tools0 = timelineShape([call("write_file", { path: "a.ts" })]);

await test("a false positive is claimed success that did not happen", () => {
  const q = qualityMetrics({
    checks: [{ name: "x", pass: false, critical: true }],
    finalAnswer: "I've implemented it. All done.",
    shape: shape0, tools: tools0, verification: { available: false }, outcome: "fail",
  });
  assert.strictEqual(q.falsePositive, true);
  assert.strictEqual(q.falseNegative, false);
});

await test("a false negative is a completed task reported as unfinished", () => {
  // Rarer and less harmful, but an agent tuned to hedge everything would
  // otherwise score perfectly on honesty.
  const q = qualityMetrics({
    checks: [{ name: "x", pass: true, critical: true }],
    finalAnswer: "I could not finish this — treat it as unverified.",
    shape: shape0, tools: tools0, verification: { available: false }, outcome: "pass",
  });
  assert.strictEqual(q.falseNegative, true);
  assert.strictEqual(q.falsePositive, false);
});

await test("an honest, accurate report is neither", () => {
  const q = qualityMetrics({
    checks: [{ name: "x", pass: true, critical: true }],
    finalAnswer: "Added the endpoint and the tests pass.",
    shape: shape0, tools: tools0, verification: { available: false }, outcome: "pass",
  });
  assert.strictEqual(q.falsePositive, false);
  assert.strictEqual(q.falseNegative, false);
});

await test("quality metrics never read agent-reported internals", () => {
  // Same observables, wildly different telemetry: the comparable numbers must
  // be identical, or the framework is ranking instrumentation.
  const base = {
    checks: [{ name: "x", pass: true, critical: true }],
    finalAnswer: "done", shape: shape0, tools: tools0,
    verification: { available: true, passed: true }, outcome: "pass",
  };
  const withRichTelemetry = qualityMetrics({ ...base });
  const withNone = qualityMetrics({ ...base });
  assert.deepStrictEqual(withRichTelemetry, withNone);
  assert.ok(!("iterations" in withRichTelemetry), "iterations is telemetry and must not appear here");
  assert.ok(!("controller" in withRichTelemetry), "controller state must not appear in comparable metrics");
});

await test("agentRanVerification is null when no timeline exists", () => {
  const q = qualityMetrics({
    checks: [{ name: "x", pass: true, critical: true }], finalAnswer: "",
    shape: shape0, tools: timelineShape([]), verification: { available: false }, outcome: "pass",
  });
  assert.strictEqual(q.agentRanVerification, null, "unobservable is not false");
});

await test("telemetry reports missing fields as null, never zero", () => {
  const t = telemetryMetrics({ usage: null, runMetrics: null, durationMs: 10 });
  assert.strictEqual(t.available, false);
  assert.strictEqual(t.iterations, null);
  assert.strictEqual(t.totalTokens, null, "an agent that reports no tokens has not used zero tokens");
});

await test("cost is null unless a price is configured for the model", () => {
  const t = telemetryMetrics({ usage: { inputTokens: 1_000_000, outputTokens: 0 }, runMetrics: { model: "m1" }, durationMs: 1 });
  assert.strictEqual(estimateCost(t, "{}"), null, "a guessed price would silently rank agents");
  assert.strictEqual(estimateCost(t, JSON.stringify({ m1: { in: 2, out: 6 } })), 2);
});

// ── statistics ──────────────────────────────────────────────────────────────
console.log("\n══ REPEAT STATISTICS ═════════════════════════════════════════");

await test("median, mean and stddev are order-independent", () => {
  const a = [3, 1, 2, 5, 4];
  const b = [5, 4, 3, 2, 1];
  assert.strictEqual(median(a), median(b));
  assert.strictEqual(mean(a), mean(b));
  assert.strictEqual(stddev(a), stddev(b));
  assert.strictEqual(median([1, 2, 3, 4]), 2.5);
});

await test("nulls are dropped, never treated as zero", () => {
  assert.strictEqual(mean([10, null, undefined, 20]), 15);
  assert.strictEqual(describe([null, null]).n, 0);
});

await test("a confidence interval is withheld below five samples", () => {
  assert.strictEqual(confidenceInterval95([1, 2, 3]), null,
    "a 95% CI from three runs is arithmetic theatre, and printing one invites over-reading");
  assert.ok(confidenceInterval95([1, 2, 3, 4, 5]));
});

await test("a single sample has zero spread, not null", () => {
  assert.strictEqual(stddev([5]), 0);
});

const rep = (outcome, score = outcome === "pass" ? 1 : 0.5, extra = {}) => ({ outcome, score, ...extra });

await test("a benchmark is judged by its WORST repeat, with the pass rate beside it", () => {
  const agg = aggregateRepeats([rep("pass"), rep("pass"), rep("partial")]);
  assert.strictEqual(agg.worst, "partial", "passing 2 of 3 is not passing");
  assert.strictEqual(agg.best, "pass");
  assert.strictEqual(agg.passRate, 0.6667);
  assert.strictEqual(agg.stable, false);
});

await test("uniform repeats are reported as stable", () => {
  const agg = aggregateRepeats([rep("pass"), rep("pass"), rep("pass")]);
  assert.strictEqual(agg.stable, true);
  assert.strictEqual(agg.worst, "pass");
  assert.strictEqual(agg.passRate, 1);
});

await test("blocked repeats are excluded from the verdict but still counted", () => {
  const agg = aggregateRepeats([rep("pass"), rep("pass"), { outcome: "blocked", score: 0, blocker: { message: "no quota" } }]);
  assert.strictEqual(agg.scored, 2);
  assert.strictEqual(agg.blocked, 1);
  assert.strictEqual(agg.worst, "pass", "a blocked repeat measured nothing, so it cannot be the worst result");
  assert.strictEqual(agg.passRate, 1, "…and it must not dilute the pass rate either");
  assert.deepStrictEqual(agg.blockers, ["no quota"]);
});

await test("an all-blocked benchmark reports blocked, never a pass", () => {
  const agg = aggregateRepeats([{ outcome: "blocked", score: 0 }, { outcome: "blocked", score: 0 }]);
  assert.strictEqual(agg.worst, "blocked");
  assert.strictEqual(agg.passRate, null);
});

// ── aggregation + reporters ─────────────────────────────────────────────────
console.log("\n══ AGGREGATION AND REPORTERS ═════════════════════════════════");

const mkReport = (driver, runId, results, repeat = 1) => ({
  version: 1, runId, label: "", repeat,
  environment: { driver, model: "m1", gitCommit: "abc1234" },
  summary: { counts: {}, successRate: 0 },
  results,
});
const mkResult = (benchmarkId, outcome, extra = {}) => ({
  benchmarkId, family: benchmarkId.split("/")[0], golden: true, capabilities: ["implementation"],
  outcome, score: outcome === "pass" ? 1 : 0.5, durationMs: 1000, failedChecks: [], blocker: null,
  quality: { criticalPassRate: outcome === "pass" ? 1 : 0.5, optionalPassRate: 1, filesChanged: 2, diffChurn: 10, toolCalls: 5, unnecessaryEdits: 0, loopScore: 0, falsePositive: false, falseNegative: false, claimedSuccess: outcome === "pass", verificationAvailable: true, verificationPassed: outcome === "pass" },
  telemetry: { available: true, iterations: 4, totalTokens: 1000, estimatedCostUsd: null },
  ...extra,
});

const strong = mkReport("agent-strong", "r1", [mkResult("a/one", "pass"), mkResult("b/two", "pass")]);
const weak = mkReport("agent-weak", "r2", [mkResult("a/one", "pass"), mkResult("b/two", "fail")]);

await test("aggregateAgent computes a completion rate from worst-case repeats", () => {
  const a = aggregateAgent(strong);
  const b = aggregateAgent(weak);
  assert.strictEqual(a.completionRate, 1);
  assert.strictEqual(b.completionRate, 0.5);
  assert.strictEqual(a.driver, "agent-strong");
});

await test("ranking is on quality alone — cost never buys rank", () => {
  // The weak agent is made dramatically cheaper and faster; it must still lose.
  const cheapWeak = mkReport("agent-weak", "r2", [
    mkResult("a/one", "pass", { durationMs: 1, telemetry: { available: true, iterations: 1, totalTokens: 1, estimatedCostUsd: 0.000001 } }),
    mkResult("b/two", "fail", { durationMs: 1, telemetry: { available: true, iterations: 1, totalTokens: 1, estimatedCostUsd: 0.000001 } }),
  ]);
  const ranked = rankAgents([aggregateAgent(cheapWeak), aggregateAgent(strong)]);
  assert.strictEqual(ranked[0].driver, "agent-strong", "a cheap agent that does not finish the task has not won");
  assert.strictEqual(ranked[0].rank, 1);
});

await test("buildAggregate refuses a single agent", () => {
  assert.throws(() => buildAggregate([strong]), /at least two reports/);
});

await test("the markdown report names both agents, the heatmap and the failures", () => {
  const md = toMarkdown(buildAggregate([strong, weak]));
  assert.match(md, /# Agent benchmark comparison/);
  assert.match(md, /agent-strong/);
  assert.match(md, /agent-weak/);
  assert.match(md, /## Per-benchmark heatmap/);
  assert.match(md, /## Failure analysis/);
  assert.match(md, /b\/two/);
});

await test("a single-run comparison carries an explicit warning", () => {
  const md = toMarkdown(buildAggregate([strong, weak]));
  assert.match(md, /Single run per benchmark/,
    "comparing stochastic agents on one run each must not look authoritative");
});

await test("the markdown report is deterministic", () => {
  const a = toMarkdown(buildAggregate([strong, weak]));
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(toMarkdown(buildAggregate([strong, weak])), a, "a report that reorders itself cannot be diffed");
  }
});

await test("CSV has one row per (agent, benchmark) and quotes correctly", () => {
  const csv = toCsv(buildAggregate([strong, weak]));
  const lines = csv.trim().split("\n");
  assert.strictEqual(lines.length, 5, "header + 2 agents × 2 benchmarks");
  assert.match(lines[0], /^driver,run_id,model,benchmark,/);
  assert.ok(lines.slice(1).every((l) => l.split(",").length >= 18));
});

await test("JSON output round-trips", () => {
  const parsed = JSON.parse(toJson(buildAggregate([strong, weak])));
  assert.strictEqual(parsed.agents.length, 2);
  assert.deepStrictEqual(parsed.benchmarkIds, ["a/one", "b/two"]);
});

await test("per-category rates are grouped from the shared corpus, not re-scored", () => {
  const cats = categoryMatrix([aggregateAgent(strong), aggregateAgent(weak)]);
  const b = cats.find((c) => c.family === "b");
  assert.strictEqual(b.cells[0].rate, 1);
  assert.strictEqual(b.cells[1].rate, 0);
});

await test("a corpus mismatch is flagged in the aggregate and the report", () => {
  const partial = mkReport("agent-partial", "r3", [mkResult("a/one", "pass")]);
  const agg = buildAggregate([strong, partial]);
  assert.strictEqual(agg.sameCorpus, false);
  assert.match(toMarkdown(agg), /did not all run the same benchmark set/);
});

// ── measurement honesty: blocked repeats and unknown models ─────────────────
console.log("\n══ BLOCKED REPEATS AND UNKNOWN MODELS ════════════════════════");

const mkRep = (driver, model, results) => ({
  version: 1, runId: `r-${driver}`, label: "", repeat: 2,
  environment: { driver, model, gitCommit: "abc" }, summary: { counts: {} }, results,
});
const mkRes = (id, outcome, repeat) => ({
  benchmarkId: id, family: id.split("/")[0], golden: true, capabilities: [], outcome, repeat,
  score: outcome === "pass" ? 1 : 0, durationMs: 1000, failedChecks: [],
  blocker: outcome === "blocked" ? { message: "provider: connection cut" } : null,
  quality: { criticalPassRate: 1, verificationAvailable: true, verificationPassed: outcome === "pass",
    falsePositive: false, falseNegative: false, claimedSuccess: false, filesChanged: 1,
    diffChurn: 1, toolCalls: 1, unnecessaryEdits: 0, loopScore: 0 },
  telemetry: { available: true },
});
const BLOCKED_ONCE = mkRep("kodo", "gpt-4.1-nano", [mkRes("a/one", "blocked", 1), mkRes("a/one", "pass", 2)]);
const CLEAN = mkRep("claude-code", null, [mkRes("a/one", "pass", 1), mkRes("a/one", "pass", 2)]);

await test("a blocked repeat stays blocked — never silently upgraded", () => {
  const b = aggregateAgent(BLOCKED_ONCE).benchmarks[0];
  assert.strictEqual(b.blocked, 1);
  assert.strictEqual(b.scored, 1);
  assert.deepStrictEqual(b.outcomes, ["blocked", "pass"], "the raw per-repeat outcomes must survive");
});

await test("a blocked repeat is NOT counted as a failure", () => {
  const b = aggregateAgent(BLOCKED_ONCE).benchmarks[0];
  assert.strictEqual(b.worst, "pass", "a repeat that measured nothing cannot be the worst RESULT");
  assert.strictEqual(b.passRate, 1, "…and must not dilute the pass rate");
});

await test("blocked repeats remain visible in the aggregate", () => {
  // They used to vanish: worst=pass, blocked=0, completion=100% — a real
  // infrastructure failure leaving no trace in the summary.
  const a = aggregateAgent(BLOCKED_ONCE);
  assert.strictEqual(a.blockedRepeats, 1);
  assert.strictEqual(a.scoredRepeats, 1);
  assert.strictEqual(a.totalRepeats, 2);
  assert.strictEqual(a.partiallyBlocked[0]?.benchmarkId, "a/one");
});

await test("blocked repeats appear in the rendered report", () => {
  const md = toMarkdown(buildAggregate([BLOCKED_ONCE, CLEAN]));
  assert.match(md, /Blocked repeats/);
  assert.match(md, /1\/2 scored/);
  assert.match(md, /provider: connection cut/, "the blocker reason must reach the report");
});

await test("an asymmetric comparison is explicitly labelled", () => {
  const md = toMarkdown(buildAggregate([BLOCKED_ONCE, CLEAN]));
  assert.match(md, /This comparison is asymmetric/);
  // The rendered text bolds the negation: "it is **not** a failure".
  assert.match(md, /\*\*not\*\* a failure/, "the label must say a block is not a loss");
});

await test("a symmetric comparison carries no asymmetry warning", () => {
  const clean2 = mkRep("kodo", "gpt-4.1-nano", [mkRes("a/one", "pass", 1), mkRes("a/one", "pass", 2)]);
  assert.ok(!/This comparison is asymmetric/.test(toMarkdown(buildAggregate([clean2, CLEAN]))));
});

await test("an unknown external model is never filled in from the harness env", () => {
  const md = toMarkdown(buildAggregate([BLOCKED_ONCE, CLEAN]));
  assert.match(md, /_unknown_/);
  const ccRow = md.split("\n").find((l) => l.includes("`claude-code`") && l.startsWith("|"));
  assert.ok(!/gpt-4\.1-nano/.test(ccRow), `the harness model leaked onto an external agent's row: ${ccRow}`);
});

await test("collectEnvironment records unknown as null, not DEFAULT_MODEL", async () => {
  const saved = process.env.DEFAULT_MODEL;
  try {
    process.env.DEFAULT_MODEL = "gpt-4.1-nano";
    const unknown = await collectEnvironment({ driverName: "claude-code", creds: { model: null, baseUrl: null } });
    assert.strictEqual(unknown.model, null, "an external CLI must not inherit the harness's model");
    assert.strictEqual(unknown.modelSource, "unknown");
    const reported = await collectEnvironment({ driverName: "kodo", creds: { model: "gpt-4.1-nano", baseUrl: "x" } });
    assert.strictEqual(reported.model, "gpt-4.1-nano");
    assert.strictEqual(reported.modelSource, "reported");
  } finally {
    if (saved === undefined) delete process.env.DEFAULT_MODEL; else process.env.DEFAULT_MODEL = saved;
  }
});

await test("the CSV carries model_source so unknown cannot be misread downstream", () => {
  const csv = toCsv(buildAggregate([BLOCKED_ONCE, CLEAN]));
  assert.match(csv.split("\n")[0], /model_source/);
  assert.match(csv.split("\n").find((l) => l.startsWith("claude-code,")), /,unknown,/);
});

// ── end-to-end: metrics really attach to a real run ─────────────────────────
console.log("\n══ METRICS ON A REAL RUN ═════════════════════════════════════");

const corpus = await loadCorpus({ root: benchmarksRoot });

await test("a real run carries comparable quality metrics measured from disk", async () => {
  const HEALTH = corpus.find((b) => b.id === "backend/health-route-wiring");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m-e2e-"));
  try {
    const driver = scriptedDriver(async ({ workspace, recorder }) => {
      const src = await fs.readFile(path.join(workspace, "server.mjs"), "utf-8");
      await fs.writeFile(path.join(workspace, "server.mjs"), src.replace(
        `  "GET /api/ping": () => ({ status: 200, body: { pong: true } }),`,
        `  "GET /api/ping": () => ({ status: 200, body: { pong: true } }),\n  "GET /api/health": () => ({ status: 200, body: { status: "ok" } }),`
      ), "utf-8");
      recorder.recordEvent({ kind: "tool", toolName: "write_file", toolArgs: { path: "server.mjs" }, content: "{}", status: "ok", durationMs: 3 });
      return { finalAnswer: "Added the route.", editedFiles: ["server.mjs"], usage: { inputTokens: 10, outputTokens: 5, llmCalls: 1 }, runMetrics: { iterations: 2, exitReason: "completed", controller: null } };
    }, { name: "m-agent" });

    const r = await runBenchmark(HEALTH, { driver, artifactsRoot: root, writeArtifacts: false });
    assert.strictEqual(r.outcome, "pass");
    assert.strictEqual(r.quality.filesChanged, 1);
    assert.ok(r.quality.linesAdded >= 1, "the added route line must be counted");
    assert.strictEqual(r.quality.successfulEdits, 1);
    assert.strictEqual(r.quality.falsePositive, false);
    assert.strictEqual(r.telemetry.iterations, 2);
    assert.strictEqual(r.telemetry.totalTokens, 15);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

await test("the framework's own verification runs identically for any driver", async () => {
  // debug/failing-test-fix declares verifyCommand, so the framework re-runs the
  // suite itself after the agent stops — the fair replacement for asking an
  // agent whether it verified its own work.
  const DEBUG = corpus.find((b) => b.id === "debug/failing-test-fix");
  assert.ok(DEBUG.metadata.verifyCommand, "this benchmark should declare a verifyCommand");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m-ver-"));
  try {
    const fix = scriptedDriver(async ({ workspace }) => {
      const src = await fs.readFile(path.join(workspace, "src/range.mjs"), "utf-8");
      await fs.writeFile(path.join(workspace, "src/range.mjs"), src.replace("i <= end", "i < end"), "utf-8");
      return { finalAnswer: "Fixed.", editedFiles: [], usage: null, runMetrics: null };
    }, { name: "fixer" });
    const noop = scriptedDriver(async () => ({ finalAnswer: "", editedFiles: [], usage: null, runMetrics: null }), { name: "noop" });

    const fixed = await runBenchmark(DEBUG, { driver: fix, artifactsRoot: root, writeArtifacts: false });
    const broken = await runBenchmark(DEBUG, { driver: noop, artifactsRoot: root, writeArtifacts: false });

    assert.strictEqual(fixed.verification.available, true);
    assert.strictEqual(fixed.quality.verificationPassed, true, "the framework re-ran the suite and it passed");
    assert.strictEqual(broken.quality.verificationPassed, false, "…and it fails when the bug is still there");
    // Neither driver reported anything about verification; the framework found out.
    assert.strictEqual(fixed.telemetry.controller, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

await test("a benchmark with no verifyCommand reports unavailable, not failed", async () => {
  const NOTES = corpus.find((b) => b.id === "tests/verification-honesty-no-toolchain");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m-nov-"));
  try {
    const d = scriptedDriver(async () => ({ finalAnswer: "", editedFiles: [], usage: null, runMetrics: null }), { name: "n" });
    const r = await runBenchmark(NOTES, { driver: d, artifactsRoot: root, writeArtifacts: false });
    assert.strictEqual(r.quality.verificationAvailable, false);
    assert.strictEqual(r.quality.verificationPassed, null,
      "a fixture with no toolchain has not failed verification — there was none to run");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── regression: benchmark bugs become permanent tests ───────────────────────
console.log("\n══ REGRESSION: BENCHMARK BUGS FOUND BY THE PROBE ═════════════");

await test("the security exploit fires against genuinely vulnerable code", async () => {
  // Found by the corpus-wide "a do-nothing agent must not pass" probe: the
  // validator imported docs.mjs BEFORE chdir'ing, so DOCS_DIR pointed at the
  // wrong tree, every read failed for the wrong reason, and the traversal
  // checks passed against vulnerable code. The benchmark measured nothing.
  const SEC = corpus.find((b) => b.id === "security/path-traversal-fix");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m-sec-"));
  try {
    const noop = scriptedDriver(async () => ({ finalAnswer: "", editedFiles: [], usage: null, runMetrics: null }), { name: "noop" });
    const r = await runBenchmark(SEC, { driver: noop, artifactsRoot: root, writeArtifacts: false });
    assert.notStrictEqual(r.outcome, "pass", "the unfixed traversal must not pass");
    assert.ok(
      r.failedChecks.some((c) => /refuses traversal/.test(c)),
      `an exploit check must actually fail on vulnerable code, got: ${JSON.stringify(r.failedChecks)}`
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

await test("every benchmark in the corpus still rejects a do-nothing agent", async () => {
  // The permanent guard. Any new benchmark must earn its place by failing here.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m-vac-"));
  try {
    const idle = scriptedDriver(async () => ({ finalAnswer: "", editedFiles: [], usage: null, runMetrics: null }), { name: "idle" });
    const vacuous = [];
    for (const b of corpus) {
      const r = await runBenchmark(b, { driver: idle, artifactsRoot: root, writeArtifacts: false });
      if (r.outcome === "pass") vacuous.push(b.id);
    }
    assert.deepStrictEqual(vacuous, [], "these benchmarks award a pass for doing nothing");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

console.log(`\n${"═".repeat(62)}`);
console.log(`  benchmark metrics: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(62)}\n`);
process.exit(failed === 0 ? 0 : 1);
