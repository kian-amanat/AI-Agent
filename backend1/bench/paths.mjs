/**
 * bench/paths.mjs
 * The handful of locations the benchmark system cares about, resolved once.
 *
 * Everything the benchmark system writes lives under `benchRunsRoot` — kept
 * deliberately outside the agent's own memory (memory.db, .kodo/, .agent-history)
 * so a benchmark run can never be mistaken for, or contaminate, real session
 * history. Benchmarks read from `benchmarksRoot` and never write to it.
 */

import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** backend1/ */
export const backendRoot = path.resolve(__dirname, "..");

/** repo root (the parent of backend1/) */
export const repoRoot = path.resolve(backendRoot, "..");

/** The benchmark corpus: benchmarks/<family>/<name>/ */
export const benchmarksRoot =
  process.env.KODO_BENCH_CORPUS
    ? path.resolve(process.env.KODO_BENCH_CORPUS)
    : path.join(repoRoot, "benchmarks");

/**
 * Where run artifacts land: <root>/<runId>/…
 * Separate from the agent's live memory on purpose (see file header).
 */
export const benchRunsRoot =
  process.env.KODO_BENCH_RUNS
    ? path.resolve(process.env.KODO_BENCH_RUNS)
    : path.join(repoRoot, ".bench-runs");

/** Directory of a single run. */
export function runDir(runId, root = benchRunsRoot) {
  return path.join(root, runId);
}

/** Directory holding one benchmark's artifacts inside a run. */
export function benchmarkArtifactDir(runId, benchmarkId, root = benchRunsRoot) {
  return path.join(runDir(runId, root), "benchmarks", slugifyId(benchmarkId));
}

/** `frontend/add-helper` → `frontend__add-helper` (filesystem-safe, reversible enough). */
export function slugifyId(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]+/g, "__");
}
