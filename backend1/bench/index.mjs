/**
 * bench/index.mjs — the benchmark framework's public surface.
 * Everything the CLI and the tests use goes through here.
 */

export { loadCorpus, selectBenchmarks, CAPABILITIES, DIFFICULTIES, EXPECTED_OUTCOMES } from "./corpus.mjs";
export { createWorkspace, destroyWorkspace, snapshotWorkspace, diffSnapshots } from "./workspace.mjs";
export { createRecorder } from "./recorder.mjs";
export { runValidator, createValidatorHelpers, normalizeChecks } from "./validators.mjs";
export { scoreRun, summarize, claimedSuccess, endedEarly, OUTCOMES } from "./scoring.mjs";
export { runBenchmark, runSuite, newRunId, collectEnvironment } from "./runner.mjs";
export { kodoDriver, scriptedDriver, DRIVERS } from "./drivers.mjs";
export { loadReport, compareReports, formatReport, formatComparison } from "./compare.mjs";
export { loadReplay, formatReplay, replayPath } from "./replay.mjs";
export { benchmarksRoot, benchRunsRoot, runDir, benchmarkArtifactDir } from "./paths.mjs";
