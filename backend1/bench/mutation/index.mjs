/**
 * bench/mutation/index.mjs
 * Testing the tests: does each benchmark's validator actually detect failure?
 *
 * A benchmark suite is only worth what its validators can catch. Every other
 * guarantee in this framework — deterministic scoring, fair drivers, honest
 * blockers — is downstream of one unverified assumption: that when an agent
 * does the wrong thing, some check goes red. Nothing so far tests that
 * assumption directly. The corpus-wide "a do-nothing agent must not pass" probe
 * is the weakest possible version of it: it proves a validator notices when
 * NOTHING happened, not when something *plausible but wrong* happened.
 *
 * So: take the known-good solution, damage it in a specific, realistic way, and
 * require the validator to notice. A mutation the validator survives is a hole
 * — a class of wrong answer that would score as a pass.
 *
 * This is mutation testing pointed at the oracle rather than the code, and it
 * is the only way to answer "can this benchmark be trusted".
 */

import fs from "fs/promises";
import path from "path";
import os from "os";

import { runBenchmark } from "../runner.mjs";
import { scriptedDriver } from "../drivers.mjs";

/**
 * A mutation: a named, deliberate defect applied to a workspace.
 *
 * @typedef {object} Mutation
 * @property {string} name        what wrong thing this represents
 * @property {(ws: string) => Promise<void>} apply
 * @property {string} [expectCheck] substring of the check that should catch it;
 *                                  when given, that specific check must fail —
 *                                  not merely "something did"
 */

/** Write a file inside the mutated workspace. */
export async function put(ws, rel, content) {
  const abs = path.join(ws, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
}

export async function patch(ws, rel, fn) {
  const abs = path.join(ws, rel);
  const before = await fs.readFile(abs, "utf-8");
  await fs.writeFile(abs, fn(before), "utf-8");
}

/**
 * Run one benchmark with a driver that applies `solution`, then `mutation`.
 * @returns the benchmark result
 */
async function runMutant(benchmark, solution, mutation, artifactsRoot) {
  const driver = scriptedDriver(async ({ workspace }) => {
    await solution(workspace);
    if (mutation) await mutation.apply(workspace);
    return {
      // A deliberately confident claim: a validator that only catches the
      // mutation because the agent SAID it failed is not catching the mutation.
      finalAnswer: "I've implemented the change and verified it.",
      editedFiles: [], usage: null, runMetrics: null,
    };
  }, { name: mutation ? `mutant:${mutation.name}` : "reference" });

  return runBenchmark(benchmark, { driver, artifactsRoot, writeArtifacts: false });
}

/**
 * Grade one benchmark's validator.
 *
 * The reference solution must PASS — a validator that rejects a correct answer
 * is broken in the other direction, and grading its strictness would be
 * meaningless. Then every mutation must fail.
 */
export async function gradeValidator({ benchmark, solution, mutations }, { artifactsRoot } = {}) {
  const root = artifactsRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), "kodo-mutation-"));
  const owned = !artifactsRoot;
  const findings = [];

  try {
    const reference = await runMutant(benchmark, solution, null, root);
    if (reference.outcome !== "pass") {
      return {
        benchmarkId: benchmark.id,
        trustworthy: false,
        referencePassed: false,
        caught: 0,
        total: mutations.length,
        findings: [{
          name: "(reference solution)",
          caught: false,
          detail:
            `the known-good solution does not pass (${reference.outcome}: ` +
            `${reference.failedChecks.join(", ")}). Until that is fixed, nothing can be said ` +
            "about what this validator catches.",
        }],
      };
    }

    for (const mutation of mutations) {
      const r = await runMutant(benchmark, solution, mutation, root);
      const caught = r.outcome !== "pass";
      const byExpected = mutation.expectCheck
        ? r.failedChecks.some((c) => c.includes(mutation.expectCheck))
        : true;

      findings.push({
        name: mutation.name,
        caught: caught && byExpected,
        outcome: r.outcome,
        failedChecks: r.failedChecks,
        detail: !caught
          ? "the validator awarded a PASS to a mutated solution — this class of wrong answer is invisible to it"
          : !byExpected
            ? `caught, but not by the expected check (${mutation.expectCheck}); it failed on: ${r.failedChecks.join(", ")}`
            : "",
      });
    }

    const caught = findings.filter((f) => f.caught).length;
    return {
      benchmarkId: benchmark.id,
      referencePassed: true,
      caught,
      total: mutations.length,
      // A benchmark is only trustworthy if EVERY mutation is caught. One
      // survivor is one shape of wrong answer that scores as success.
      trustworthy: caught === mutations.length,
      findings,
    };
  } finally {
    if (owned) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/** Grade a list of specs. */
export async function gradeAll(specs, opts = {}) {
  const results = [];
  for (const spec of specs) results.push(await gradeValidator(spec, opts));
  return {
    results,
    graded: results.length,
    trustworthy: results.filter((r) => r.trustworthy).length,
    holes: results.flatMap((r) => r.findings.filter((f) => !f.caught).map((f) => ({ benchmarkId: r.benchmarkId, mutation: f.name, detail: f.detail }))),
  };
}

/** Human-readable grading report. */
export function formatQualityReport(report, { coveredIds = [], allIds = [] } = {}) {
  const L = [];
  L.push("");
  L.push("═".repeat(74));
  L.push("  Benchmark Quality Report — can these validators detect a wrong answer?");
  L.push("═".repeat(74));
  L.push("");

  for (const r of report.results) {
    const icon = r.trustworthy ? "✅" : "❌";
    L.push(`${icon} ${r.benchmarkId}`);
    L.push("   validator:");
    for (const f of r.findings) {
      L.push(`     ${f.caught ? "✅" : "❌"} ${f.caught ? "catches" : "MISSES"} ${f.name}`);
      if (f.detail) L.push(`        ↳ ${f.detail}`);
    }
    L.push(`   score: ${r.caught}/${r.total}`);
    L.push("");
  }

  const ungraded = allIds.filter((id) => !coveredIds.includes(id));
  L.push("─".repeat(74));
  L.push(`  ${report.trustworthy}/${report.graded} graded benchmark(s) catch every mutation`);
  if (report.holes.length) {
    L.push("");
    L.push("  Holes — a wrong answer of this shape would score as a PASS:");
    for (const h of report.holes) L.push(`    ✗ ${h.benchmarkId} · ${h.mutation}`);
  }
  if (ungraded.length) {
    L.push("");
    L.push(`  ⚠️  ${ungraded.length} benchmark(s) have NO mutation coverage and are therefore ungraded —`);
    L.push("      their validators are unproven, not proven good:");
    for (const id of ungraded) L.push(`        · ${id}`);
  }
  L.push("═".repeat(74));
  L.push("");
  return L.join("\n");
}
