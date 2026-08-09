/**
 * bench/stats.mjs
 * Aggregation across repeated runs.
 *
 * An LLM agent is a stochastic process. A single run of a benchmark tells you
 * what happened once, and the difference between two agents measured once each
 * is frequently smaller than the difference between the same agent measured
 * twice. Every comparable number in this framework therefore travels with its
 * spread, and `worst` is reported alongside `median` on purpose: an agent that
 * passes two runs in three is not "passing", and an average hides that.
 *
 * Pure and deterministic. Sample order never changes a result — every function
 * sorts or accumulates commutatively, so the same multiset always yields the
 * same statistics.
 */

const round = (n, dp = 4) => {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/** Numeric samples only; nulls are dropped, never coerced to 0. */
function clean(values) {
  return values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
}

export function median(values) {
  const v = clean(values);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return round(v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2);
}

export function mean(values) {
  const v = clean(values);
  if (!v.length) return null;
  return round(v.reduce((a, b) => a + b, 0) / v.length);
}

/** Population standard deviation. n<2 → 0 (a single sample has no spread). */
export function stddev(values) {
  const v = clean(values);
  if (v.length < 2) return v.length ? 0 : null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return round(Math.sqrt(v.reduce((acc, x) => acc + (x - m) ** 2, 0) / v.length));
}

/**
 * Normal-approximation 95% CI on the mean.
 *
 * Returned only for n ≥ 5. Below that the interval is arithmetic theatre — a
 * 95% CI from three runs of a bimodal pass/fail process is not information, and
 * printing one would invite exactly the over-reading this module exists to
 * prevent. `null` is the honest answer for a small sample.
 */
export function confidenceInterval95(values) {
  const v = clean(values);
  if (v.length < 5) return null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((acc, x) => acc + (x - m) ** 2, 0) / (v.length - 1));
  const margin = 1.96 * (sd / Math.sqrt(v.length));
  return { low: round(m - margin), high: round(m + margin), n: v.length };
}

/** The full spread of one numeric metric. */
export function describe(values) {
  const v = clean(values);
  if (!v.length) return { n: 0, mean: null, median: null, min: null, max: null, stddev: null, ci95: null };
  return {
    n: v.length,
    mean: mean(v),
    median: median(v),
    min: round(v[0]),
    max: round(v[v.length - 1]),
    stddev: stddev(v),
    ci95: confidenceInterval95(v),
  };
}

/** Rank order for outcomes. Shared with compare.mjs so they cannot drift. */
export const OUTCOME_RANK = { blocked: 0, fail: 1, stopped_early: 2, needs_user: 2, partial: 3, pass: 4 };

/**
 * Collapse repeats of ONE benchmark into a stable verdict.
 *
 * `worst` is the headline, not `median`: a benchmark that passes sometimes is a
 * flaky benchmark, and reporting the median would launder that into a pass.
 * `passRate` carries the nuance.
 *
 * Blocked repeats are excluded from the verdict entirely — they measured
 * nothing — but counted, so "2/3 passed, 1 blocked" never reads as "2/3".
 */
export function aggregateRepeats(results) {
  const blocked = results.filter((r) => r.outcome === "blocked");
  const scored = results.filter((r) => r.outcome !== "blocked");

  if (!scored.length) {
    return {
      repeats: results.length, scored: 0, blocked: blocked.length,
      worst: "blocked", best: "blocked", passRate: null, stable: false,
      outcomes: results.map((r) => r.outcome),
      blockers: [...new Set(blocked.map((b) => b.blocker?.message).filter(Boolean))],
      score: { n: 0, mean: null, median: null, min: null, max: null, stddev: null, ci95: null },
    };
  }

  const ranked = [...scored].sort((a, b) => OUTCOME_RANK[a.outcome] - OUTCOME_RANK[b.outcome]);
  const passes = scored.filter((r) => r.outcome === "pass").length;

  return {
    repeats: results.length,
    scored: scored.length,
    blocked: blocked.length,
    worst: ranked[0].outcome,
    best: ranked[ranked.length - 1].outcome,
    passRate: round(passes / scored.length),
    // "Stable" means every scored repeat agreed. Anything else is flaky, and
    // flaky is a result in its own right.
    stable: new Set(scored.map((r) => r.outcome)).size === 1,
    outcomes: results.map((r) => r.outcome),
    blockers: [...new Set(blocked.map((b) => b.blocker?.message).filter(Boolean))],
    score: describe(scored.map((r) => r.score)),
  };
}

/**
 * Aggregate one agent's whole run: per-benchmark verdicts plus the spread of
 * every comparable metric.
 */
export function aggregateAgent(report) {
  const byBenchmark = new Map();
  for (const r of report.results) {
    if (!byBenchmark.has(r.benchmarkId)) byBenchmark.set(r.benchmarkId, []);
    byBenchmark.get(r.benchmarkId).push(r);
  }

  const benchmarks = [...byBenchmark.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([benchmarkId, runs]) => ({
      benchmarkId,
      family: runs[0].family,
      golden: runs[0].golden,
      capabilities: runs[0].capabilities ?? [],
      ...aggregateRepeats(runs),
    }));

  const scored = report.results.filter((r) => r.outcome !== "blocked");
  const q = (fn) => describe(scored.map(fn));

  return {
    driver: report.environment?.driver ?? "(unknown)",
    runId: report.runId,
    label: report.label ?? "",
    model: report.environment?.model ?? null,
    repeat: report.repeat ?? 1,
    benchmarks,
    // A benchmark counts as passed only if EVERY scored repeat passed.
    completionRate: benchmarks.length
      ? round(benchmarks.filter((b) => b.worst === "pass").length / benchmarks.length)
      : null,
    flakyCount: benchmarks.filter((b) => !b.stable && b.scored > 1).length,
    // Benchmarks where EVERY repeat blocked — nothing was measured at all.
    blockedCount: benchmarks.filter((b) => b.scored === 0).length,
    // Individual repeats that blocked, even where another repeat scored. These
    // used to vanish: a benchmark with one blocked and one passing repeat
    // reported `worst: pass`, `blocked: 0`, and 100% completion, so a real
    // infrastructure failure left no trace in the summary and the agent looked
    // to have run a clean suite. Counting them keeps the asymmetry visible.
    blockedRepeats: benchmarks.reduce((n, b) => n + b.blocked, 0),
    scoredRepeats: benchmarks.reduce((n, b) => n + b.scored, 0),
    totalRepeats: benchmarks.reduce((n, b) => n + b.repeats, 0),
    partiallyBlocked: benchmarks.filter((b) => b.blocked > 0 && b.scored > 0)
      .map((b) => ({ benchmarkId: b.benchmarkId, blocked: b.blocked, scored: b.scored, blockers: b.blockers })),
    quality: {
      score: q((r) => r.score),
      criticalPassRate: q((r) => r.quality?.criticalPassRate),
      optionalPassRate: q((r) => r.quality?.optionalPassRate),
      filesChanged: q((r) => r.quality?.filesChanged),
      diffChurn: q((r) => r.quality?.diffChurn),
      toolCalls: q((r) => r.quality?.toolCalls),
      unnecessaryEdits: q((r) => r.quality?.unnecessaryEdits),
      loopScore: q((r) => r.quality?.loopScore),
      durationMs: q((r) => r.durationMs),
    },
    honesty: {
      falsePositives: scored.filter((r) => r.quality?.falsePositive).length,
      falseNegatives: scored.filter((r) => r.quality?.falseNegative).length,
      successClaims: scored.filter((r) => r.quality?.claimedSuccess).length,
      // Of the runs where the framework could verify independently, how many
      // actually pass. Same command, same workspace, every agent.
      independentlyVerified: scored.filter((r) => r.quality?.verificationPassed === true).length,
      independentlyVerifiable: scored.filter((r) => r.quality?.verificationAvailable).length,
    },
    telemetry: {
      available: scored.some((r) => r.telemetry?.available),
      iterations: q((r) => r.telemetry?.iterations),
      totalTokens: q((r) => r.telemetry?.totalTokens),
      estimatedCostUsd: q((r) => r.telemetry?.estimatedCostUsd),
    },
  };
}
