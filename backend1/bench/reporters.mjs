/**
 * bench/reporters.mjs
 * Rendering an agent comparison into the formats different readers need.
 *
 *   json      machine-readable, the full structure, nothing summarised away
 *   csv       one row per (agent, benchmark) — for a spreadsheet or a notebook
 *   markdown  the human report: ranking, heatmap, cost, failures
 *
 * Every renderer is a pure function of the aggregate. Determinism matters more
 * than it looks: a report that reorders itself between runs cannot be diffed,
 * and diffing two reports is how a regression gets noticed. So every list is
 * sorted by a stable key, and no renderer reads the clock.
 */

import { OUTCOME_RANK } from "./stats.mjs";

const ICON = { pass: "✅", partial: "🟡", fail: "❌", blocked: "🚧", stopped_early: "🛑", needs_user: "❓", not_run: "·" };
const CELL = { pass: "P", partial: "~", fail: "F", blocked: "B", stopped_early: "S", needs_user: "Q", not_run: "·" };

const pct = (n) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(1)}%`);
const num = (n, dp = 2) => (n === null || n === undefined ? "—" : Number(n).toFixed(dp));
const ms = (n) => (n === null || n === undefined ? "—" : `${(n / 1000).toFixed(1)}s`);

/** mean ± sd, or just the value when there is no spread to report. */
function spread(d) {
  if (!d || d.n === 0) return "—";
  if (d.n === 1 || !d.stddev) return num(d.median);
  return `${num(d.median)} ±${num(d.stddev)}`;
}

/**
 * Rank agents. Quality first, and only quality — cost never buys rank.
 *
 * Order: completion rate → independent verification → fewer false positives →
 * less churn. Cost and speed are reported beside the ranking, never inside it:
 * a cheap agent that does not finish the task has not won anything, and folding
 * cost into a single score is how a benchmark starts rewarding the wrong thing.
 */
export function rankAgents(agents) {
  return [...agents]
    .sort((a, b) =>
      (b.completionRate ?? 0) - (a.completionRate ?? 0) ||
      (b.honesty.independentlyVerified ?? 0) - (a.honesty.independentlyVerified ?? 0) ||
      (a.honesty.falsePositives ?? 0) - (b.honesty.falsePositives ?? 0) ||
      (a.quality.diffChurn.median ?? 0) - (b.quality.diffChurn.median ?? 0) ||
      a.driver.localeCompare(b.driver))
    .map((a, i) => ({ rank: i + 1, ...a }));
}

/** Pass rate per family, per agent. The per-category ranking. */
export function categoryMatrix(agents) {
  const families = [...new Set(agents.flatMap((a) => a.benchmarks.map((b) => b.family)))].sort();
  return families.map((family) => ({
    family,
    cells: agents.map((a) => {
      const scoped = a.benchmarks.filter((b) => b.family === family);
      const scored = scoped.filter((b) => b.scored > 0);
      return {
        driver: a.driver,
        total: scoped.length,
        passed: scoped.filter((b) => b.worst === "pass").length,
        rate: scored.length ? scoped.filter((b) => b.worst === "pass").length / scoped.length : null,
      };
    }),
  }));
}

export function toJson(aggregate) {
  return `${JSON.stringify(aggregate, null, 2)}\n`;
}

/** One row per (agent, benchmark). Stable column order; RFC-4180 quoting. */
export function toCsv(aggregate) {
  const cols = [
    "driver", "run_id", "model", "benchmark", "family", "golden", "capabilities",
    "model_source", "repeats", "scored", "blocked", "worst", "best", "pass_rate", "stable",
    "score_median", "score_min", "score_max", "score_stddev",
  ];
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [cols.join(",")];
  for (const a of aggregate.agents) {
    for (const b of a.benchmarks) {
      rows.push([
        a.driver, a.runId, a.model ?? "", b.benchmarkId, b.family, b.golden,
        (b.capabilities ?? []).join("|"), a.model ? "reported" : "unknown",
        b.repeats, b.scored, b.blocked,
        b.worst, b.best, b.passRate ?? "", b.stable,
        b.score.median ?? "", b.score.min ?? "", b.score.max ?? "", b.score.stddev ?? "",
      ].map(esc).join(","));
    }
  }
  return `${rows.join("\n")}\n`;
}

export function toMarkdown(aggregate) {
  const ranked = rankAgents(aggregate.agents);
  const L = [];
  const row = (cells) => L.push(`| ${cells.join(" | ")} |`);
  const sep = (n) => L.push(`|${" --- |".repeat(n)}`);

  L.push("# Agent benchmark comparison");
  L.push("");
  L.push(`Corpus: **${aggregate.benchmarkCount}** benchmark(s) · repeats: **${aggregate.repeat}** · agents: **${ranked.length}**`);
  if (!aggregate.sameCorpus) {
    L.push("");
    L.push("> ⚠️ The agents did not all run the same benchmark set. Rows marked `·` were never attempted, and any ranking below is provisional.");
  }
  if (aggregate.repeat < 2) {
    L.push("");
    L.push("> ⚠️ Single run per benchmark. These numbers carry no spread — an LLM agent is stochastic, and a one-run gap between two agents is frequently smaller than the gap between one agent and itself. Re-run with `--repeat 3` or more before drawing a conclusion.");
  }
  L.push("");

  // ── ranking ──
  L.push("## Overall ranking");
  L.push("");
  L.push("Ranked on quality only — completion, then independent verification, then honesty, then restraint. Cost and speed are reported but never buy rank.");
  L.push("");
  row(["#", "Agent", "Model", "Completion", "Scored runs", "Verified", "False pos.", "False neg.", "Flaky", "Blocked repeats"]);
  sep(10);
  for (const a of ranked) {
    row([
      a.rank, `\`${a.driver}\``, a.model ?? "_unknown_", pct(a.completionRate),
      `${a.scoredRepeats}/${a.totalRepeats}`,
      `${a.honesty.independentlyVerified}/${a.honesty.independentlyVerifiable}`,
      a.honesty.falsePositives, a.honesty.falseNegatives, a.flakyCount,
      a.blockedRepeats > 0 ? `**${a.blockedRepeats}**` : "0",
    ]);
  }
  L.push("");
  if (ranked.some((a) => a.model === null)) {
    L.push("`_unknown_` — that agent selects its own model and does not expose it. It is **not** the model in the harness's `DEFAULT_MODEL`; assuming so would misattribute the harness's configuration to an external CLI.");
    L.push("");
  }

  // Asymmetry has to be stated where the ranking is read, not buried below it.
  const scoredCounts = new Set(ranked.map((a) => a.scoredRepeats));
  const anyBlocked = ranked.some((a) => a.blockedRepeats > 0);
  if (anyBlocked || scoredCounts.size > 1) {
    L.push("> ⚠️ **This comparison is asymmetric.** The agents did not complete the same number of scored runs:");
    L.push(">");
    for (const a of ranked) {
      L.push(`> - \`${a.driver}\`: ${a.scoredRepeats}/${a.totalRepeats} scored${a.blockedRepeats ? `, **${a.blockedRepeats} blocked**` : ""}`);
      for (const pb of a.partiallyBlocked) {
        L.push(`>   - \`${pb.benchmarkId}\` — ${pb.blocked} of ${pb.blocked + pb.scored} repeat(s) blocked: ${(pb.blockers[0] ?? "unknown").slice(0, 160)}`);
      }
    }
    L.push(">");
    L.push("> A blocked repeat measured nothing, so it is excluded from the verdict — it is **not** a failure. But it means one agent was given fewer chances, and any ranking margin smaller than that gap is not evidence.");
    L.push("");
  }

  // ── heatmap ──
  L.push("## Per-benchmark heatmap");
  L.push("");
  L.push("`P` pass · `~` partial · `F` fail · `S` stopped early · `Q` needs user · `B` blocked · `·` not run. A cell shows the **worst** of that benchmark's repeats.");
  L.push("");
  row(["Benchmark", ...ranked.map((a) => `\`${a.driver}\``), "Agree"]);
  sep(ranked.length + 2);
  for (const id of aggregate.benchmarkIds) {
    const cells = ranked.map((a) => a.benchmarks.find((b) => b.benchmarkId === id));
    const outcomes = cells.map((c) => c?.worst ?? "not_run");
    const agree = new Set(outcomes).size === 1;
    row([
      `\`${id}\``,
      ...cells.map((c, i) => {
        if (!c) return CELL.not_run;
        const flaky = !c.stable && c.scored > 1 ? "*" : "";
        return `${CELL[outcomes[i]] ?? "?"}${flaky}`;
      }),
      agree ? "" : "**≠**",
    ]);
  }
  L.push("");
  L.push("`*` marks a benchmark whose repeats disagreed — the agent is flaky there, which is itself a result.");
  L.push("");

  // ── per-category ──
  L.push("## Per-category pass rate");
  L.push("");
  row(["Category", ...ranked.map((a) => `\`${a.driver}\``)]);
  sep(ranked.length + 1);
  for (const cat of categoryMatrix(ranked)) {
    row([cat.family, ...ranked.map((a) => {
      const c = cat.cells.find((x) => x.driver === a.driver);
      return c && c.total ? `${pct(c.rate)} (${c.passed}/${c.total})` : "—";
    })]);
  }
  L.push("");

  // ── quality ──
  L.push("## Quality");
  L.push("");
  L.push("Median ± population standard deviation across repeats. Every metric here is derived from the workspace, the validators, or the agent's own words — never from agent-reported internals, so it is comparable across drivers.");
  L.push("");
  row(["Metric", ...ranked.map((a) => `\`${a.driver}\``)]);
  sep(ranked.length + 1);
  const qrow = (label, pick) => row([label, ...ranked.map((a) => spread(pick(a)))]);
  qrow("score", (a) => a.quality.score);
  qrow("critical checks passed", (a) => a.quality.criticalPassRate);
  qrow("optional checks passed", (a) => a.quality.optionalPassRate);
  qrow("files changed", (a) => a.quality.filesChanged);
  qrow("lines changed (churn)", (a) => a.quality.diffChurn);
  qrow("tool calls", (a) => a.quality.toolCalls);
  qrow("unnecessary re-edits", (a) => a.quality.unnecessaryEdits);
  qrow("loop score", (a) => a.quality.loopScore);
  L.push("");

  // ── cost & speed ──
  L.push("## Cost and speed");
  L.push("");
  L.push("`—` means the agent does not report that figure. It is **not** zero: an external CLI agent exposes no token accounting, and printing 0 would make it look free.");
  L.push("");
  row(["Metric", ...ranked.map((a) => `\`${a.driver}\``)]);
  sep(ranked.length + 1);
  row(["telemetry available", ...ranked.map((a) => (a.telemetry.available ? "yes" : "no"))]);
  row(["iterations", ...ranked.map((a) => spread(a.telemetry.iterations))]);
  row(["total tokens", ...ranked.map((a) => spread(a.telemetry.totalTokens))]);
  row(["est. cost (USD)", ...ranked.map((a) => spread(a.telemetry.estimatedCostUsd))]);
  row(["duration", ...ranked.map((a) => (a.quality.durationMs.median === null ? "—" : ms(a.quality.durationMs.median)))]);
  L.push("");

  // ── failure analysis ──
  L.push("## Failure analysis");
  L.push("");
  for (const a of ranked) {
    const failing = a.benchmarks.filter((b) => b.worst !== "pass");
    L.push(`### \`${a.driver}\``);
    L.push("");
    if (!failing.length) {
      L.push("Every benchmark passed on every repeat.");
      L.push("");
      continue;
    }
    for (const b of failing) {
      const flaky = !b.stable && b.scored > 1 ? ` — flaky: ${b.outcomes.join(", ")}` : "";
      L.push(`- \`${b.benchmarkId}\` → **${b.worst}**${flaky}`);
      for (const msg of b.blockers) L.push(`  - 🚧 ${msg}`);
    }
    L.push("");
  }

  // ── strengths / weaknesses ──
  L.push("## Strengths and weaknesses");
  L.push("");
  const cats = categoryMatrix(ranked);
  for (const a of ranked) {
    const mine = cats
      .map((c) => ({ family: c.family, ...c.cells.find((x) => x.driver === a.driver) }))
      .filter((c) => c.total > 0 && c.rate !== null);
    const strong = mine.filter((c) => c.rate === 1).map((c) => c.family);
    const weak = mine.filter((c) => c.rate === 0).map((c) => c.family);
    L.push(`- \`${a.driver}\` — strong: ${strong.length ? strong.join(", ") : "—"} · weak: ${weak.length ? weak.join(", ") : "—"}`);
  }
  L.push("");
  return `${L.join("\n")}\n`;
}
