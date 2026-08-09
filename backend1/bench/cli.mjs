#!/usr/bin/env node
/**
 * bench/cli.mjs — the benchmark command surface.
 *
 *   npm run bench -- list
 *   npm run bench -- run [--golden] [--family debug] [--id frontend/x] [--repeat 2]
 *   npm run bench -- report <runId|path>
 *   npm run bench -- compare <baseline> <current> [--fail-on-regression]
 *   npm run bench -- replay <runId> <benchmarkId> [--verbose]
 *   npm run bench -- baseline <runId>            # promote a run to the baseline
 *
 * `run` drives the REAL agent against a REAL model: it costs money and time,
 * and is not part of `npm test`. The framework's own correctness is covered by
 * tests/benchmarkFramework.test.mjs, which runs offline.
 */

// MUST stay first: fills process.env from backend1/.env (then the repo root's)
// before anything reads credentials, exactly as server.mjs does. Without it the
// CLI would see no key and block every benchmark, even with .env fully set up.
import "../config/env.mjs";

import fs from "fs/promises";
import path from "path";

import { loadCorpus, selectBenchmarks } from "./corpus.mjs";
import { runSuite, newRunId } from "./runner.mjs";
import { getDriver, listDrivers, formatDriverStatusReport } from "./drivers.mjs";
import { loadReport, compareReports, compareAgents, buildAggregate, formatReport, formatComparison, formatAgentComparison } from "./compare.mjs";
import { toJson, toCsv, toMarkdown } from "./reporters.mjs";
import { loadReplay, formatReplay, replayPath } from "./replay.mjs";
import { benchRunsRoot, runDir, benchmarksRoot } from "./paths.mjs";

const BASELINE_FILE = path.join(benchRunsRoot, "baseline.json");

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else { flags[key] = next; i++; }
    } else positional.push(a);
  }
  return { flags, positional };
}

const list = (v) => (v === undefined || v === true ? undefined : String(v).split(",").map((s) => s.trim()).filter(Boolean));

/** Accept either a runId under .bench-runs/ or a direct path to a summary.json. */
async function resolveReportPath(ref) {
  if (ref === "baseline") return BASELINE_FILE;
  const asFile = path.resolve(ref);
  const stat = await fs.stat(asFile).catch(() => null);
  if (stat?.isFile()) return asFile;
  if (stat?.isDirectory()) return path.join(asFile, "summary.json");
  return path.join(runDir(ref), "summary.json");
}

async function cmdList(flags) {
  const corpus = await loadCorpus();
  const selected = selectBenchmarks(corpus, {
    ids: list(flags.id),
    families: list(flags.family),
    golden: !!flags.golden,
    difficulty: flags.difficulty === true ? undefined : flags.difficulty,
    capabilities: list(flags.capability),
  });
  console.log(`\n${selected.length} benchmark(s) in ${benchmarksRoot}\n`);
  let family = null;
  for (const b of selected) {
    if (b.family !== family) { family = b.family; console.log(`  ${family}/`); }
    if (!b.valid) { console.log(`    🚧 ${b.name.padEnd(34)} INVALID — ${b.reason}`); continue; }
    const m = b.metadata;
    console.log(`    ${m.golden ? "⭐" : "  "} ${b.name.padEnd(34)} ${m.difficulty.padEnd(5)} ${m.capabilities.join(",")}`);
  }
  const invalid = selected.filter((b) => !b.valid).length;
  console.log(`\n  ${selected.filter((b) => b.valid && b.metadata.golden).length} golden, ${invalid} invalid\n`);
  return invalid === 0 ? 0 : 1;
}

async function cmdRun(flags, positional) {
  const corpus = await loadCorpus();
  // Benchmark ids may be given positionally (`bench run a/b c/d`) or via
  // --id. Positional is the syntax people reach for first, and silently
  // ignoring it would run the whole corpus instead of the two benchmarks
  // asked for — an expensive, wrong-by-default surprise.
  const ids = [...(list(flags.id) ?? []), ...positional];
  const selected = selectBenchmarks(corpus, {
    ids: ids.length ? ids : undefined,
    families: list(flags.family),
    golden: !!flags.golden,
    difficulty: flags.difficulty === true ? undefined : flags.difficulty,
    capabilities: list(flags.capability),
  });
  if (!selected.length) {
    console.error("No benchmarks matched the given filters.");
    return 1;
  }

  // One corpus, many agents: --driver picks which one is measured. Everything
  // downstream (fixtures, validators, scoring) is identical whichever is chosen.
  const driver = getDriver(typeof flags.driver === "string" ? flags.driver : "kodo");
  const runId = typeof flags.run === "string" ? flags.run : newRunId();
  const repeat = flags.repeat === undefined ? 1 : Math.max(1, parseInt(flags.repeat, 10) || 1);

  // Fail fast. Discovering a logged-out agent one benchmark at a time wastes
  // the operator's time and, for the agents that DO work, real money.
  const preBlock = await driver.preflight?.({ benchmark: selected[0] });
  if (preBlock) {
    console.error(`\n🚧 driver "${driver.name}" is blocked: ${preBlock.reason ?? preBlock.stage}`);
    console.error(`   ${preBlock.message}`);
    console.error("\n   Nothing was run. Resolve this and rerun.\n");
    return 2;
  }

  console.log(`\nRunning ${selected.length} benchmark(s)${repeat > 1 ? ` × ${repeat} repeat(s)` : ""} as ${runId} [driver: ${driver.name}]`);
  console.log("This drives the real agent loop against a real model — real API calls, real cost.\n");

  const report = await runSuite(selected, {
    driver,
    runId,
    label: typeof flags.label === "string" ? flags.label : "",
    repeat,
    keepWorkspace: !!flags["keep-workspace"],
    onProgress: (r) => {
      const icon = { pass: "✅", partial: "🟡", fail: "❌", blocked: "🚧", stopped_early: "🛑", needs_user: "❓" }[r.outcome];
      console.log(`  ${icon} ${r.outcome.padEnd(13)} ${r.benchmarkId}  (${r.criticalPassed}/${r.criticalTotal} checks, ${(r.durationMs / 1000).toFixed(1)}s)`);
      if (r.blocker) console.log(`       🚧 ${r.blocker.stage}: ${r.blocker.message}`);
    },
  });

  console.log(formatReport(report));
  console.log(`Artifacts: ${runDir(runId)}\n`);

  // Auto-compare against the promoted baseline when one exists — the whole
  // point is that a regression is visible without anyone remembering to look.
  if (await fs.stat(BASELINE_FILE).catch(() => null)) {
    const cmp = compareReports(await loadReport(BASELINE_FILE), report);
    console.log(formatComparison(cmp));
    if (cmp.hasRegressions && flags["fail-on-regression"]) return 1;
  }

  // A blocked benchmark means the suite did not actually evaluate that task.
  // Exiting 0 on that would be the dishonesty this system exists to prevent.
  if (report.summary.counts.blocked > 0) return 2;
  return report.summary.counts.pass === report.results.length ? 0 : 1;
}

async function cmdReport(positional) {
  const ref = positional[0];
  if (!ref) { console.error("usage: bench report <runId|path|baseline>"); return 1; }
  const report = await loadReport(await resolveReportPath(ref));
  console.log(formatReport(report));
  return report.summary.counts.blocked > 0 ? 2 : 0;
}

async function cmdCompare(positional, flags) {
  const [baseRef, currRef] = positional;
  if (!baseRef || !currRef) {
    console.error("usage: bench compare <baseline-runId|path|baseline> <current-runId|path>");
    return 1;
  }
  const baseline = await loadReport(await resolveReportPath(baseRef));
  const current = await loadReport(await resolveReportPath(currRef));
  const cmp = compareReports(baseline, current);
  console.log(formatComparison(cmp));
  if (flags["json"]) console.log(JSON.stringify(cmp, null, 2));
  if (flags["fail-on-regression"] && cmp.hasRegressions) return 1;
  return 0;
}

async function cmdReplay(positional, flags) {
  const [runRef, benchmarkId] = positional;
  if (!runRef) { console.error("usage: bench replay <runId> <benchmarkId>   |   bench replay <path-to-replay.json>"); return 1; }
  const target = benchmarkId ? replayPath(runRef, benchmarkId) : path.resolve(runRef);
  const replay = await loadReplay(target);
  console.log(formatReplay(replay, { verbose: !!flags.verbose }));
  return 0;
}

async function cmdBaseline(positional) {
  const ref = positional[0];
  if (!ref) { console.error("usage: bench baseline <runId|path>"); return 1; }
  const file = await resolveReportPath(ref);
  const report = await loadReport(file);
  // Promoting a run that could not evaluate itself would bake a blind spot
  // into every future comparison.
  if (report.summary.counts.blocked > 0) {
    console.error(`Refusing to promote ${report.runId}: it contains ${report.summary.counts.blocked} blocked benchmark(s). Fix the blockers first.`);
    return 1;
  }
  await fs.mkdir(path.dirname(BASELINE_FILE), { recursive: true });
  await fs.copyFile(file, BASELINE_FILE);
  console.log(`Promoted ${report.runId} to the baseline (${BASELINE_FILE}).`);
  return 0;
}

/**
 * "ready" means executable AND authenticated.
 *
 * The previous version checked only PATH, so an installed-but-logged-out CLI
 * read as ready and an operator could commit to a comparison that could only
 * ever produce blocked runs. Preflight now actually talks to each agent.
 */
async function cmdDrivers() {
  // Probe every registered driver, then render. Collecting first means one
  // driver's failure cannot truncate the listing for the rest.
  const statuses = [];
  for (const name of listDrivers()) {
    let blocker = null;
    try {
      blocker = (await getDriver(name).preflight?.({})) ?? null;
    } catch (err) {
      // A preflight that THROWS must still appear, or the driver vanishes from
      // the listing entirely and looks like it was never registered.
      blocker = { status: "blocked", reason: "preflight_error", stage: "preflight", message: String(err?.message ?? err) };
    }
    statuses.push({ name, blocker });
  }
  console.log(formatDriverStatusReport(statuses));
  return statuses.some((s) => s.blocker) ? 2 : 0;
}

/**
 * Grade the validators themselves: apply realistic wrong answers to each covered
 * benchmark and require the validator to notice. A validator that survives a
 * mutation is measuring less than it claims.
 */
async function cmdQuality(flags) {
  const { gradeAll, formatQualityReport } = await import("./mutation/index.mjs");
  const { specsFor } = await import("./mutation/specs.mjs");

  const corpus = await loadCorpus();
  let specs = specsFor(corpus);
  if (typeof flags.id === "string") {
    const wanted = new Set(list(flags.id));
    specs = specs.filter((s) => wanted.has(s.benchmark.id));
  }
  if (!specs.length) { console.error("No mutation specs matched."); return 1; }

  console.log(`\nGrading ${specs.length} validator(s) against ${specs.reduce((n, s) => n + s.mutations.length, 0)} mutation(s)…`);
  const report = await gradeAll(specs);
  console.log(formatQualityReport(report, {
    coveredIds: specs.map((s) => s.benchmark.id),
    allIds: corpus.filter((b) => b.valid).map((b) => b.id),
  }));
  if (flags.json) console.log(JSON.stringify(report, null, 2));
  // A surviving mutation is a hole in the suite, and the exit code says so.
  return report.holes.length ? 1 : 0;
}

async function cmdCompareAgents(positional, flags) {
  if (positional.length < 2) {
    console.error("usage: bench compare-agents <runId|path> <runId|path> [more…]");
    return 1;
  }
  const reports = [];
  for (const ref of positional) reports.push(await loadReport(await resolveReportPath(ref)));
  const cmp = compareAgents(reports);
  const aggregate = buildAggregate(reports);

  // --out writes every machine format beside the human one, so a report can be
  // diffed, charted and read without re-running anything.
  if (typeof flags.out === "string") {
    await fs.mkdir(flags.out, { recursive: true });
    await fs.writeFile(path.join(flags.out, "comparison.md"), toMarkdown(aggregate), "utf-8");
    await fs.writeFile(path.join(flags.out, "comparison.json"), toJson(aggregate), "utf-8");
    await fs.writeFile(path.join(flags.out, "comparison.csv"), toCsv(aggregate), "utf-8");
    console.log(`Wrote comparison.md / .json / .csv to ${flags.out}`);
  }
  if (flags.format === "markdown") { console.log(toMarkdown(aggregate)); return 0; }
  if (flags.format === "csv") { console.log(toCsv(aggregate)); return 0; }
  if (flags.format === "json" || flags.json) { console.log(toJson(aggregate)); return 0; }

  console.log(formatAgentComparison(cmp));
  return 0;
}

const USAGE = `
Kodo benchmark suite

  npm run bench -- list [--golden] [--family <f,…>] [--capability <c,…>] [--difficulty easy|hard]
  npm run bench -- drivers
  npm run bench -- quality [--id <benchmarkId,…>] [--json]
  npm run bench -- run  [<benchmarkId>…] [filters…] [--driver kodo|claude-code|codex] [--repeat N] [--label "..."] [--fail-on-regression] [--keep-workspace]
  npm run bench -- report  <runId|path|baseline>
  npm run bench -- compare <baseline|runId|path> <runId|path> [--fail-on-regression] [--json]
  npm run bench -- compare-agents <runId|path> <runId|path> [more…] [--format markdown|csv|json] [--out DIR]
  npm run bench -- replay  <runId> <benchmarkId> [--verbose]
  npm run bench -- baseline <runId|path>

Exit codes:  0 all passed · 1 failures/regressions · 2 something was BLOCKED (not evaluated)
`;

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional.shift() ?? "help";
  switch (cmd) {
    case "list":     return cmdList(flags);
    case "drivers":  return cmdDrivers();
    case "quality":  return cmdQuality(flags);
    case "compare-agents": return cmdCompareAgents(positional, flags);
    case "run":      return cmdRun(flags, positional);
    case "report":   return cmdReport(positional);
    case "compare":  return cmdCompare(positional, flags);
    case "replay":   return cmdReplay(positional, flags);
    case "baseline": return cmdBaseline(positional);
    default:
      console.log(USAGE);
      return cmd === "help" ? 0 : 1;
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    // An unexpected harness failure is itself a blocker — say so plainly
    // rather than letting it look like the suite ran and did badly.
    console.error(`\n🚧 The benchmark harness failed before it could finish: ${err?.message ?? err}`);
    if (process.env.KODO_BENCH_DEBUG) console.error(err);
    process.exit(2);
  });
