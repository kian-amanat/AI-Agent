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
export {
  kodoDriver, scriptedDriver, DRIVERS,
  defineDriver, registerDriver, getDriver, listDrivers,
  externalCliDriver, claudeCodeDriver, codexDriver,
} from "./drivers.mjs";
export {
  loadReport, compareReports, formatReport, formatComparison,
  compareAgents, formatAgentComparison, buildAggregate,
} from "./compare.mjs";
export {
  workspaceShape, timelineShape, qualityMetrics, telemetryMetrics,
  independentVerification, estimateCost, lineDiff,
} from "./metrics.mjs";
export {
  median, mean, stddev, confidenceInterval95, describe,
  aggregateRepeats, aggregateAgent, OUTCOME_RANK,
} from "./stats.mjs";
export { toJson, toCsv, toMarkdown, rankAgents, categoryMatrix } from "./reporters.mjs";
export { loadReplay, formatReplay, replayPath } from "./replay.mjs";
export { benchmarksRoot, benchRunsRoot, runDir, benchmarkArtifactDir } from "./paths.mjs";
