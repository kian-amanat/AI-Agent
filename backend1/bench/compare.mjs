/**
 * bench/compare.mjs
 * Comparing two runs, and rendering a report a human can act on.
 *
 * Every comparison this system needs is the same operation on two report
 * objects, which is why there is only one:
 *   • current vs baseline      — two runs of the same suite
 *   • branch vs branch         — same, with `environment.gitBranch` differing
 *   • Kodo vs a reference      — same, where the baseline is a stored reference
 *                                report checked in as the expected behaviour
 *
 * Regressions are surfaced first and loudest. An improvement that hides a
 * regression is exactly the report nobody reads twice.
 */

import fs from "fs/promises";
import { OUTCOMES } from "./scoring.mjs";

/** How good an outcome is. Only used to classify a change as better or worse. */
const RANK = { blocked: 0, fail: 1, stopped_early: 2, needs_user: 2, partial: 3, pass: 4 };

export async function loadReport(file) {
  const raw = await fs.readFile(file, "utf-8");
  const report = JSON.parse(raw);
  if (!report || !Array.isArray(report.results)) {
    throw new Error(`${file} is not a benchmark report (no \`results\` array)`);
  }
  return report;
}

/** Collapse repeats: a benchmark is only as good as its worst attempt. */
function indexResults(report) {
  const byId = new Map();
  for (const r of report.results) {
    const prev = byId.get(r.benchmarkId);
    if (!prev || RANK[r.outcome] < RANK[prev.outcome]) byId.set(r.benchmarkId, r);
  }
  return byId;
}

/**
 * Diff two reports.
 * @returns {{regressions, improvements, unchanged, added, removed, metricDeltas, ...}}
 */
export function compareReports(baseline, current) {
  const base = indexResults(baseline);
  const curr = indexResults(current);

  const regressions = [];
  const improvements = [];
  const unchanged = [];
  const added = [];
  const removed = [];

  for (const [id, c] of [...curr.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const b = base.get(id);
    if (!b) {
      added.push({ benchmarkId: id, outcome: c.outcome, golden: c.golden });
      continue;
    }
    const entry = {
      benchmarkId: id,
      golden: c.golden,
      family: c.family,
      from: b.outcome,
      to: c.outcome,
      scoreFrom: b.score,
      scoreTo: c.score,
      // The specific checks that flipped — the first thing anyone debugging a
      // regression actually wants.
      newlyFailingChecks: c.failedChecks.filter((n) => !b.failedChecks.includes(n)),
      newlyPassingChecks: b.failedChecks.filter((n) => !c.failedChecks.includes(n)),
      blocker: c.blocker ?? null,
    };
    if (RANK[c.outcome] < RANK[b.outcome]) regressions.push(entry);
    else if (RANK[c.outcome] > RANK[b.outcome]) improvements.push(entry);
    else unchanged.push(entry);
  }

  for (const id of [...base.keys()].sort()) {
    if (!curr.has(id)) removed.push({ benchmarkId: id, outcome: base.get(id).outcome });
  }

  const metricKeys = [
    "successRate", "partialRate", "failureRate", "blockedRate",
    "avgIterations", "avgTokens", "avgDurationMs",
    "verificationSuccessRate", "falsePositiveSuccessRate", "avgScore",
  ];
  const metricDeltas = {};
  for (const k of metricKeys) {
    const from = baseline.summary?.[k] ?? 0;
    const to = current.summary?.[k] ?? 0;
    metricDeltas[k] = { from, to, delta: Math.round((to - from) * 10_000) / 10_000 };
  }

  return {
    baseline: { runId: baseline.runId, label: baseline.label ?? "", environment: baseline.environment ?? null },
    current: { runId: current.runId, label: current.label ?? "", environment: current.environment ?? null },
    regressions,
    improvements,
    unchanged,
    added,
    removed,
    metricDeltas,
    // Golden benchmarks exist precisely to be a hard gate: a regression on one
    // is a stop-the-line event, not a data point.
    goldenRegressions: regressions.filter((r) => r.golden),
    hasRegressions: regressions.length > 0,
  };
}

// ── Rendering ───────────────────────────────────────────────────────────────

const ICON = {
  pass: "✅", partial: "🟡", fail: "❌", blocked: "🚧",
  stopped_early: "🛑", needs_user: "❓",
};

function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

/** The per-run report: what happened, worst first. */
export function formatReport(report) {
  const s = report.summary;
  const lines = [];
  lines.push("");
  lines.push("═".repeat(78));
  lines.push(`  Kodo benchmark report — ${report.runId}${report.label ? `  (${report.label})` : ""}`);
  lines.push("═".repeat(78));
  const env = report.environment ?? {};
  lines.push(`  driver=${env.driver ?? "?"}  model=${env.model ?? "(default)"}  branch=${env.gitBranch ?? "?"}@${env.gitCommit ?? "?"}${env.gitDirty ? "-dirty" : ""}`);
  lines.push(`  ${report.results.length} result(s) in ${(report.durationMs / 1000).toFixed(1)}s${report.repeat > 1 ? ` (${report.repeat} repeats)` : ""}`);
  lines.push("");

  // Worst outcomes first — the report is for finding problems.
  const ordered = [...report.results].sort(
    (a, b) => (RANK[a.outcome] - RANK[b.outcome]) || a.benchmarkId.localeCompare(b.benchmarkId)
  );
  for (const r of ordered) {
    const golden = r.golden ? " ⭐" : "";
    lines.push(`  ${ICON[r.outcome] ?? "•"} ${r.outcome.padEnd(13)} ${r.benchmarkId}${golden}  (${r.criticalPassed}/${r.criticalTotal} checks, score ${r.score})`);
    if (r.blocker) lines.push(`        🚧 BLOCKED at ${r.blocker.stage}: ${r.blocker.message}`);
    if (r.timedOut) lines.push(`        ⏱  hit the ${"timeout"} before finishing`);
    if (r.falsePositive) lines.push(`        ⚠️  FALSE POSITIVE — the agent claimed success but the workspace disagrees`);
    for (const c of r.checks ?? []) {
      if (!c.pass) lines.push(`        ✗ ${c.critical ? "" : "(optional) "}${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
    }
  }

  lines.push("");
  lines.push("  ── summary ".padEnd(78, "─"));
  for (const o of OUTCOMES) {
    if (s.counts[o]) lines.push(`     ${ICON[o]} ${o.padEnd(14)} ${s.counts[o]}`);
  }
  lines.push("");
  lines.push(`     success rate            ${pct(s.successRate)}`);
  lines.push(`     partial rate            ${pct(s.partialRate)}`);
  lines.push(`     failure rate            ${pct(s.failureRate)}`);
  lines.push(`     blocked rate            ${pct(s.blockedRate)}`);
  lines.push(`     verification success    ${pct(s.verificationSuccessRate)}  (${s.verificationRunCount} run(s) verified anything)`);
  lines.push(`     FALSE POSITIVE rate     ${pct(s.falsePositiveSuccessRate)}  (${s.falsePositiveCount}/${s.claimedSuccessCount} success claims were untrue)`);
  lines.push(`     avg iterations          ${s.avgIterations}`);
  lines.push(`     avg tokens              ${s.avgTokens}  (${s.avgInputTokens} in / ${s.avgOutputTokens} out)`);
  lines.push(`     avg duration            ${(s.avgDurationMs / 1000).toFixed(1)}s`);
  lines.push(`     avg tool calls          ${s.avgToolCalls}`);
  lines.push("═".repeat(78));
  lines.push("");
  return lines.join("\n");
}

/** The comparison report: what changed, regressions first. */
export function formatComparison(cmp) {
  const lines = [];
  lines.push("");
  lines.push("═".repeat(78));
  lines.push("  Kodo benchmark comparison");
  lines.push("═".repeat(78));
  const bEnv = cmp.baseline.environment ?? {};
  const cEnv = cmp.current.environment ?? {};
  lines.push(`  baseline: ${cmp.baseline.runId}${cmp.baseline.label ? ` (${cmp.baseline.label})` : ""}  [${bEnv.gitBranch ?? "?"}@${bEnv.gitCommit ?? "?"}, model=${bEnv.model ?? "?"}]`);
  lines.push(`  current : ${cmp.current.runId}${cmp.current.label ? ` (${cmp.current.label})` : ""}  [${cEnv.gitBranch ?? "?"}@${cEnv.gitCommit ?? "?"}, model=${cEnv.model ?? "?"}]`);
  lines.push("");

  if (cmp.regressions.length) {
    lines.push(`  ❌ ${cmp.regressions.length} REGRESSION(S)${cmp.goldenRegressions.length ? ` — ${cmp.goldenRegressions.length} on GOLDEN benchmark(s)` : ""}`);
    for (const r of cmp.regressions) {
      lines.push(`     ${r.golden ? "⭐ " : "   "}${r.benchmarkId}: ${r.from} → ${r.to}  (score ${r.scoreFrom} → ${r.scoreTo})`);
      for (const c of r.newlyFailingChecks) lines.push(`          ✗ now failing: ${c}`);
      if (r.blocker) lines.push(`          🚧 ${r.blocker.stage}: ${r.blocker.message}`);
    }
  } else {
    lines.push("  ✅ no regressions");
  }
  lines.push("");

  if (cmp.improvements.length) {
    lines.push(`  ✅ ${cmp.improvements.length} improvement(s)`);
    for (const r of cmp.improvements) lines.push(`     ${r.benchmarkId}: ${r.from} → ${r.to}`);
    lines.push("");
  }
  if (cmp.added.length) {
    lines.push(`  ➕ ${cmp.added.length} new benchmark(s): ${cmp.added.map((a) => `${a.benchmarkId} (${a.outcome})`).join(", ")}`);
  }
  if (cmp.removed.length) {
    lines.push(`  ➖ ${cmp.removed.length} benchmark(s) no longer run: ${cmp.removed.map((a) => a.benchmarkId).join(", ")}`);
  }
  lines.push("");
  lines.push("  ── metrics ".padEnd(78, "─"));
  for (const [k, v] of Object.entries(cmp.metricDeltas)) {
    const arrow = v.delta === 0 ? "  " : v.delta > 0 ? "▲" : "▼";
    lines.push(`     ${k.padEnd(26)} ${String(v.from).padStart(10)} → ${String(v.to).padStart(10)}  ${arrow} ${v.delta > 0 ? "+" : ""}${v.delta}`);
  }
  lines.push("═".repeat(78));
  lines.push("");
  return lines.join("\n");
}
