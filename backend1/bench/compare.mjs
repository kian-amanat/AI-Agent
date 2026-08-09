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
import { aggregateAgent } from "./stats.mjs";

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

// ── Cross-agent comparison ──────────────────────────────────────────────────

/**
 * Pass rate over the benchmarks carrying a given capability tag.
 *
 * This is how "resume completeness" and "blocker handling" become measurable
 * without inventing a second scoring system: the corpus already tags each
 * benchmark, and a capability's score is just its benchmarks' outcomes. Scoring
 * semantics are untouched and identical for every agent — only the grouping
 * differs.
 */
function capabilityRate(results, capability) {
  const scoped = results.filter((r) => (r.capabilities ?? []).includes(capability));
  if (!scoped.length) return null;
  const passed = scoped.filter((r) => r.outcome === "pass").length;
  return { rate: Math.round((passed / scoped.length) * 10_000) / 10_000, passed, total: scoped.length };
}

/** Was any real per-run telemetry available? External CLI agents report none. */
function hasTelemetry(results) {
  return results.some((r) => typeof r.metrics?.iterations === "number" || r.usage);
}

/**
 * Compare N agents over the same corpus.
 *
 * Every report must have been produced from the same benchmark set for the
 * per-benchmark matrix to mean anything, so a mismatch is surfaced rather than
 * quietly intersected.
 */
export function compareAgents(reports) {
  if (!Array.isArray(reports) || reports.length < 2) {
    throw new Error("comparing agents needs at least two reports");
  }

  const agents = reports.map((rep) => {
    const byId = indexResults(rep);
    const results = [...byId.values()];
    return {
      driver: rep.environment?.driver ?? "(unknown)",
      runId: rep.runId,
      label: rep.label ?? "",
      model: rep.environment?.model ?? null,
      gitCommit: rep.environment?.gitCommit ?? null,
      byId,
      results,
      summary: rep.summary ?? {},
      telemetry: hasTelemetry(results),
      capabilities: {
        resume: capabilityRate(results, "resume"),
        honest_blocker: capabilityRate(results, "honest_blocker"),
        verification: capabilityRate(results, "verification"),
        implementation: capabilityRate(results, "implementation"),
        wiring: capabilityRate(results, "wiring"),
      },
    };
  });

  // The union, not the intersection: a benchmark one agent ran and another did
  // not is a gap in the comparison, and hiding it would overstate the overlap.
  const allIds = [...new Set(agents.flatMap((a) => [...a.byId.keys()]))].sort();
  const sameCorpus = agents.every((a) => a.byId.size === allIds.length);

  const rows = allIds.map((id) => {
    const cells = agents.map((a) => {
      const r = a.byId.get(id);
      return r
        ? { outcome: r.outcome, score: r.score, criticalPassed: r.criticalPassed, criticalTotal: r.criticalTotal, blocker: r.blocker ?? null }
        : { outcome: "not_run", score: null, blocker: null };
    });
    const outcomes = new Set(cells.map((c) => c.outcome));
    const first = agents[0].byId.get(id);
    return {
      benchmarkId: id,
      golden: first?.golden ?? false,
      family: first?.family ?? id.split("/")[0],
      cells,
      // The whole point of the side-by-side: where do the agents disagree?
      agree: outcomes.size === 1,
      bestOutcome: [...outcomes].sort((a, b) => (RANK[b] ?? -1) - (RANK[a] ?? -1))[0],
    };
  });

  return {
    agents: agents.map(({ byId, results, ...rest }) => rest),
    benchmarks: rows,
    sameCorpus,
    differences: rows.filter((r) => !r.agree),
    agreements: rows.filter((r) => r.agree),
  };
}

/**
 * Build the statistical aggregate every reporter consumes.
 *
 * Everything downstream reads THIS, not raw reports — so the markdown, the CSV
 * and the JSON can never disagree about what happened, and adding a fourth
 * format cannot introduce a fourth interpretation.
 */
export function buildAggregate(reports) {
  if (!Array.isArray(reports) || reports.length < 2) {
    throw new Error("comparing agents needs at least two reports");
  }
  const agents = reports.map(aggregateAgent);
  const benchmarkIds = [...new Set(agents.flatMap((a) => a.benchmarks.map((b) => b.benchmarkId)))].sort();
  return {
    version: 1,
    agents,
    benchmarkIds,
    benchmarkCount: benchmarkIds.length,
    repeat: Math.min(...agents.map((a) => a.repeat ?? 1)),
    sameCorpus: agents.every((a) => a.benchmarks.length === benchmarkIds.length),
  };
}

// ── Rendering ───────────────────────────────────────────────────────────────

const ICON = {
  pass: "✅", partial: "🟡", fail: "❌", blocked: "🚧",
  stopped_early: "🛑", needs_user: "❓",
  // Cross-agent only: this agent never attempted the benchmark.
  not_run: "·",
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

/**
 * The cross-agent report: one column per agent, disagreements first.
 *
 * A metric an agent could not report prints as `—`, never as 0. An external CLI
 * agent exposes no iteration or token counts, and showing zeros there would
 * read as "infinitely efficient" next to a driver that reports honestly.
 */
export function formatAgentComparison(cmp) {
  const { agents, benchmarks, differences } = cmp;
  const W = 14;
  const cell = (s) => String(s).padEnd(W).slice(0, W);
  const lines = [];

  lines.push("");
  lines.push("═".repeat(30 + W * agents.length));
  lines.push("  Kodo cross-agent benchmark comparison");
  lines.push("═".repeat(30 + W * agents.length));
  for (const a of agents) {
    lines.push(`  ${a.driver.padEnd(14)} run=${a.runId}${a.label ? ` (${a.label})` : ""}  model=${a.model ?? "—"}  commit=${a.gitCommit ?? "—"}`);
  }
  if (!cmp.sameCorpus) {
    lines.push("");
    lines.push("  ⚠️  the agents did not all run the same benchmark set — rows marked `not_run` were never attempted");
  }
  lines.push("");

  // Per-benchmark matrix, disagreements first: that is what a comparison is for.
  lines.push(`  ${"benchmark".padEnd(44)}${agents.map((a) => cell(a.driver)).join("")}`);
  lines.push(`  ${"─".repeat(44 + W * agents.length)}`);
  const ordered = [...differences, ...cmp.agreements];
  for (const row of ordered) {
    const label = `${row.agree ? "  " : "≠ "}${row.benchmarkId}${row.golden ? " ⭐" : ""}`;
    lines.push(`  ${label.padEnd(44)}${row.cells.map((c) => cell(`${ICON[c.outcome] ?? "·"} ${c.outcome}`)).join("")}`);
  }
  lines.push("");
  lines.push(`  ${differences.length} disagreement(s), ${cmp.agreements.length} agreement(s)`);
  lines.push("");

  // Aggregates.
  const metric = (label, fn) =>
    lines.push(`  ${label.padEnd(30)}${agents.map((a) => cell(fn(a))).join("")}`);

  lines.push("  ── outcomes ".padEnd(30 + W * agents.length, "─"));
  for (const o of OUTCOMES) {
    if (agents.some((a) => a.summary.counts?.[o])) {
      metric(`${ICON[o]} ${o}`, (a) => a.summary.counts?.[o] ?? 0);
    }
  }
  lines.push("");
  lines.push("  ── quality ".padEnd(30 + W * agents.length, "─"));
  metric("success rate", (a) => pct(a.summary.successRate ?? 0));
  metric("partial rate", (a) => pct(a.summary.partialRate ?? 0));
  metric("failure rate", (a) => pct(a.summary.failureRate ?? 0));
  metric("blocked rate", (a) => pct(a.summary.blockedRate ?? 0));
  metric("verification honesty", (a) => pct(a.summary.verificationSuccessRate ?? 0));
  metric("FALSE POSITIVE rate", (a) => pct(a.summary.falsePositiveSuccessRate ?? 0));

  lines.push("");
  lines.push("  ── capabilities (pass rate) ".padEnd(30 + W * agents.length, "─"));
  for (const cap of ["resume", "honest_blocker", "verification", "implementation", "wiring"]) {
    metric(cap.replace(/_/g, " "), (a) => {
      const c = a.capabilities[cap];
      return c ? `${pct(c.rate)} ${c.passed}/${c.total}` : "—";
    });
  }

  lines.push("");
  lines.push("  ── cost ".padEnd(30 + W * agents.length, "─"));
  // `—` where an agent reports nothing: see the function's doc comment.
  metric("avg iterations", (a) => (a.telemetry ? a.summary.avgIterations ?? "—" : "—"));
  metric("avg tokens", (a) => (a.telemetry ? a.summary.avgTokens ?? "—" : "—"));
  metric("avg tool calls", (a) => a.summary.avgToolCalls ?? "—");
  metric("avg duration", (a) => `${((a.summary.avgDurationMs ?? 0) / 1000).toFixed(1)}s`);
  lines.push("═".repeat(30 + W * agents.length));
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
