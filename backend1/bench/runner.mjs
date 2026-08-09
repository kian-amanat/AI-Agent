/**
 * bench/runner.mjs
 * Executes benchmarks and writes the artifacts everything else reads.
 *
 * One benchmark run is, in order:
 *   1. isolated workspace, seeded from the benchmark's fixture
 *   2. snapshot the tree BEFORE  (so "changed files" is measured, not claimed)
 *   3. drive Kodo with the prompt, recording every event and tool call
 *   4. snapshot the tree AFTER
 *   5. run the benchmark's validator against the real post-run tree
 *   6. score deterministically
 *   7. write replayable artifacts
 *
 * Any step that cannot be completed for an environmental reason produces a
 * `blocker`, which scoring turns into `blocked`. A blocked run is never a pass
 * and is never folded into a generic failure — the reason travels with it all
 * the way into the report.
 */

import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

import { benchRunsRoot, runDir, benchmarkArtifactDir, repoRoot } from "./paths.mjs";
import { createWorkspace, destroyWorkspace, snapshotWorkspace, diffSnapshots } from "./workspace.mjs";
import { createRecorder } from "./recorder.mjs";
import { runValidator } from "./validators.mjs";
import { scoreRun, summarize } from "./scoring.mjs";
import {
  workspaceShape, timelineShape, qualityMetrics, telemetryMetrics,
  independentVerification, estimateCost,
} from "./metrics.mjs";
import { createValidatorHelpers } from "./validators.mjs";
import { kodoDriver } from "./drivers.mjs";

const execFileAsync = promisify(execFile);

/** Largest changed-file body kept verbatim in the replay artifact. */
const MAX_CAPTURED_FILE_BYTES = 256 * 1024;

export function newRunId(now = new Date()) {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `run-${iso}`;
}

async function git(args) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: repoRoot, timeout: 5000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Identifies WHAT was benchmarked — the other half of a meaningful comparison.
 * The model and endpoint recorded here are the ones the driver actually passed
 * to the graph, not a guess assembled from env vars that something downstream
 * might have overridden.
 */
export async function collectEnvironment({ driverName, creds = null }) {
  return {
    driver: driverName,
    // NEVER fall back to the harness's own env here. An external CLI picks its
    // own model and exposes none, so `DEFAULT_MODEL` describes Kodo, not it —
    // and the fallback made a report state that Claude Code ran on
    // `gpt-4.1-nano`, which was simply untrue. Unknown is recorded as unknown.
    model: creds?.model ?? null,
    baseUrl: creds?.baseUrl ?? null,
    // How much to trust the field above.
    //   "reported"  the driver told us
    //   "unknown"   the agent chooses its own and does not expose it
    modelSource: creds?.model ? "reported" : "unknown",
    node: process.version,
    platform: process.platform,
    gitBranch: await git(["rev-parse", "--abbrev-ref", "HEAD"]),
    gitCommit: await git(["rev-parse", "--short", "HEAD"]),
    gitDirty: (await git(["status", "--porcelain"]))?.length > 0,
  };
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

async function writeJsonl(file, rows) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf-8");
}

/** Capture the post-run content of every changed file, for offline debugging. */
async function captureChangedFiles(workspace, changed) {
  const out = {};
  for (const rel of changed) {
    const abs = path.join(workspace, rel);
    try {
      const stat = await fs.stat(abs);
      if (stat.size > MAX_CAPTURED_FILE_BYTES) {
        out[rel] = { omitted: `file is ${stat.size} bytes (> ${MAX_CAPTURED_FILE_BYTES})` };
        continue;
      }
      out[rel] = { content: await fs.readFile(abs, "utf-8") };
    } catch {
      out[rel] = { deleted: true };
    }
  }
  return out;
}

/**
 * Run one benchmark.
 * @returns the result record (also written to disk under the run's artifact dir)
 */
export async function runBenchmark(benchmark, {
  driver = kodoDriver,
  runId = newRunId(),
  artifactsRoot = benchRunsRoot,
  keepWorkspace = false,
  workspaceParent,
  writeArtifacts = true,
  onProgress,
} = {}) {
  const startedAt = Date.now();
  const artifactDir = benchmarkArtifactDir(runId, benchmark.id, artifactsRoot);

  const base = {
    runId,
    benchmarkId: benchmark.id,
    family: benchmark.family,
    driver: driver.name,
    title: benchmark.valid ? benchmark.metadata.title : benchmark.id,
    difficulty: benchmark.valid ? benchmark.metadata.difficulty : null,
    golden: benchmark.valid ? benchmark.metadata.golden : false,
    capabilities: benchmark.valid ? benchmark.metadata.capabilities : [],
    expectedOutcome: benchmark.valid ? benchmark.metadata.expectedOutcome : null,
  };

  /** Assemble a fully-shaped result for an environmental stop. */
  const blockedResult = (blocker, extra = {}) => {
    const scored = scoreRun({ checks: [], blocker });
    return {
      ...base,
      ...scored,
      checks: [],
      blocker,
      durationMs: Date.now() - startedAt,
      finalAnswer: "",
      metrics: null,
      usage: null,
      workspaceChanges: { added: [], modified: [], deleted: [], changed: [] },
      agentReportedFiles: [],
      counts: { toolCalls: 0, failedToolCalls: 0, askUserCalls: 0, events: 0, toolCallsByName: {} },
      timedOut: false,
      artifactDir: writeArtifacts ? artifactDir : null,
      ...extra,
    };
  };

  // ── Blocker gate 1: the benchmark itself is malformed ─────────────────────
  if (!benchmark.valid) {
    const result = blockedResult({ stage: "corpus", message: benchmark.reason });
    if (writeArtifacts) await writeJson(path.join(artifactDir, "result.json"), result);
    onProgress?.(result);
    return result;
  }

  // ── Blocker gate 2: the driver says it cannot run ─────────────────────────
  const pre = await driver.preflight?.({ benchmark });
  if (pre) {
    const result = blockedResult(pre);
    if (writeArtifacts) await writeJson(path.join(artifactDir, "result.json"), result);
    onProgress?.(result);
    return result;
  }

  let workspace = null;
  const recorder = createRecorder({
    answerQuestion: benchmark.metadata.askUserAnswer ? () => benchmark.metadata.askUserAnswer : undefined,
  });

  try {
    // ── Blocker gate 3: the fixture workspace could not be built ────────────
    try {
      workspace = await createWorkspace(benchmark, { parentDir: workspaceParent });
    } catch (err) {
      const result = blockedResult({ stage: "workspace_setup", message: `could not create the isolated workspace: ${err.message}` });
      if (writeArtifacts) await writeJson(path.join(artifactDir, "result.json"), result);
      onProgress?.(result);
      return result;
    }

    const before = await snapshotWorkspace(workspace);

    // ── Drive the agent ─────────────────────────────────────────────────────
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, benchmark.metadata.timeoutMs);

    let run;
    try {
      run = await driver.run({
        benchmark,
        workspace,
        prompt: benchmark.prompt,
        recorder,
        signal: controller.signal,
      });
    } catch (err) {
      // The agent loop catches its own failures and returns them as text, so a
      // throw reaching here is harness-level: report it as a blocker with the
      // real message rather than scoring it as if the agent had failed a task.
      clearTimeout(timer);
      const after = await snapshotWorkspace(workspace);
      const result = blockedResult(
        { stage: "driver_error", message: `the driver threw: ${err?.message ?? err}` },
        {
          workspaceChanges: diffSnapshots(before, after),
          counts: recorder.summary(),
          timedOut,
        }
      );
      if (writeArtifacts) await persistArtifacts({ artifactDir, result, recorder, before, after, workspace, benchmark });
      onProgress?.(result);
      return result;
    } finally {
      clearTimeout(timer);
    }

    // ── Blocker gate 3b: the driver itself says it could not run ───────────
    // An installed CLI that is not authenticated exits non-zero with an
    // untouched workspace — identical in every observable way to failing the
    // task. Only the driver can tell them apart, so it says so explicitly.
    if (run?.blocker) {
      const after0 = await snapshotWorkspace(workspace);
      const result = blockedResult(run.blocker, {
        finalAnswer: run.finalAnswer ?? "",
        workspaceChanges: diffSnapshots(before, after0),
        counts: recorder.summary(),
        timedOut,
      });
      if (writeArtifacts) await persistArtifacts({ artifactDir, result, recorder, before, after: after0, workspace, benchmark });
      onProgress?.(result);
      return result;
    }

    // ── Measure reality ─────────────────────────────────────────────────────
    const after = await snapshotWorkspace(workspace);
    const workspaceChanges = diffSnapshots(before, after);

    const runContext = {
      // Everything below the line is the agent's SELF-REPORT. Validators may
      // inspect it to catch dishonesty; they must not treat it as evidence.
      finalAnswer: run?.finalAnswer ?? "",
      editedFiles: run?.editedFiles ?? [],
      usage: run?.usage ?? null,
      metrics: run?.runMetrics ?? null,
      // …and this is the measured truth.
      workspaceChanges,
      timeline: recorder.timeline,
      transcript: recorder.transcript,
      askUserCalls: recorder.askUserCalls,
      counts: recorder.summary(),
      timedOut,
    };

    // ── Blocker gate 4: the provider never answered ─────────────────────────
    // An expired key, an exhausted quota or a provider outage leaves an
    // untouched workspace, which every validator correctly reports as "nothing
    // was done". Scoring that as `fail` would blame the agent for the billing
    // account, and — worse — a suite run during an outage would report a wall
    // of red that looks exactly like a catastrophic regression.
    const providerError = runContext.metrics?.providerError;
    if (providerError) {
      const result = blockedResult(
        {
          stage: "provider",
          message: providerError.salvaged
            // The run produced an answer, which is exactly why this must be
            // called out: a salvaged prose summary with no edits is
            // indistinguishable from an agent that chose to explain instead of
            // act, and scoring it as such invents a regression that never
            // happened.
            ? `the model provider failed after ${providerError.attempts} attempt(s) and the run was cut short — ` +
              `the answer below was salvaged from what had been gathered, not produced by finishing the task: ${providerError.message}`
            : `the model provider failed after ${providerError.attempts} attempt(s), so the agent never ran: ${providerError.message}`,
        },
        {
          finalAnswer: runContext.finalAnswer,
          metrics: runContext.metrics,
          usage: runContext.usage,
          workspaceChanges,
          counts: runContext.counts,
          timedOut,
        }
      );
      if (writeArtifacts) await persistArtifacts({ artifactDir, result, recorder, before, after, workspace, benchmark });
      onProgress?.(result);
      return result;
    }

    // ── Blocker gate 5: the validator could not reach a verdict ─────────────
    const { checks, blocker } = await runValidator(benchmark, { workspace, run: runContext });

    // Measured identically for every driver, from the workspace and the
    // checks — never from what the agent says about its own internals. See the
    // header of bench/metrics.mjs for why that separation is load-bearing.
    const shape = await workspaceShape({ workspace, fixtureDir: benchmark.fixtureDir, workspaceChanges });
    const tools = timelineShape(recorder.timeline);
    const verification = await independentVerification({
      workspace, benchmark, run: createValidatorHelpers(workspace).run,
    });

    const scored = scoreRun({
      checks,
      blocker,
      metrics: runContext.metrics,
      askUserCalls: recorder.askUserCalls.length,
      finalAnswer: runContext.finalAnswer,
    });

    const result = {
      ...base,
      ...scored,
      checks,
      blocker,
      durationMs: Date.now() - startedAt,
      finalAnswer: runContext.finalAnswer,
      metrics: runContext.metrics,
      usage: runContext.usage,
      workspaceChanges,
      agentReportedFiles: [...runContext.editedFiles].sort(),
      // Recorded because a disagreement between what the agent says it edited
      // and what the disk says is itself a bug worth seeing in a report.
      // `null` when the driver cannot self-report which files it touched — an
      // external CLI agent prints prose, not a file manifest. Comparing its
      // empty list against a workspace it really did change would score a
      // missing capability as a false claim, and make every non-Kodo agent look
      // dishonest in the cross-agent report. Unknown is recorded as unknown.
      reportMatchesDisk: driver.reportsEditedFiles === false
        ? null
        : sameSet(runContext.editedFiles, [...workspaceChanges.added, ...workspaceChanges.modified]),
      counts: runContext.counts,
      // Comparable across agents.
      quality: qualityMetrics({
        checks, finalAnswer: runContext.finalAnswer, shape, tools, verification,
        outcome: scoredOutcomeFor(scored, blocker),
      }),
      // Agent-reported; displayed, never ranked.
      telemetry: (() => {
        const t = telemetryMetrics({
          usage: runContext.usage, runMetrics: runContext.metrics, durationMs: Date.now() - startedAt,
        });
        t.estimatedCostUsd = estimateCost(t);
        return t;
      })(),
      verification,
      timedOut,
      artifactDir: writeArtifacts ? artifactDir : null,
    };

    if (writeArtifacts) await persistArtifacts({ artifactDir, result, recorder, before, after, workspace, benchmark });
    onProgress?.(result);
    return result;
  } finally {
    if (!keepWorkspace) await destroyWorkspace(workspace);
  }
}

/** The outcome as scored — extracted so metrics and the record cannot disagree. */
function scoredOutcomeFor(scored, blocker) {
  return blocker ? "blocked" : scored.outcome;
}

function sameSet(a, b) {
  const A = new Set(a.map(String));
  const B = new Set(b.map(String));
  if (A.size !== B.size) return false;
  for (const x of A) if (!B.has(x)) return false;
  return true;
}

async function persistArtifacts({ artifactDir, result, recorder, before, after, workspace, benchmark }) {
  const changes = result.workspaceChanges;
  await writeJson(path.join(artifactDir, "result.json"), result);
  await writeJsonl(path.join(artifactDir, "transcript.jsonl"), recorder.transcript);
  await writeJson(path.join(artifactDir, "timeline.json"), recorder.timeline);
  await writeJson(path.join(artifactDir, "workspace.json"), { before, after, changes });
  await writeJson(path.join(artifactDir, "replay.json"), {
    version: 1,
    benchmark: {
      id: benchmark.id,
      family: benchmark.family,
      prompt: benchmark.prompt,
      expected: benchmark.expected,
      metadata: benchmark.metadata,
    },
    result: { ...result, checks: result.checks },
    // A replay is only useful if it contains the run — not a pointer to it.
    transcript: recorder.transcript,
    timeline: recorder.timeline,
    askUserCalls: recorder.askUserCalls,
    streamedContent: recorder.streamedContent,
    changedFiles: await captureChangedFiles(workspace, changes.added.concat(changes.modified)),
    deletedFiles: changes.deleted,
  });
}

/**
 * Run a whole suite, sequentially. Sequential on purpose: benchmarks run real
 * commands and real model calls, and interleaving them makes durations and
 * token counts incomparable between runs — which would defeat the point.
 */
export async function runSuite(benchmarks, {
  driver = kodoDriver,
  runId = newRunId(),
  artifactsRoot = benchRunsRoot,
  label = "",
  repeat = 1,
  writeArtifacts = true,
  keepWorkspace = false,
  workspaceParent,
  onProgress,
} = {}) {
  const startedAt = new Date();
  const results = [];

  for (let attempt = 1; attempt <= repeat; attempt++) {
    for (const benchmark of benchmarks) {
      const result = await runBenchmark(benchmark, {
        driver,
        // Repeats land in their own sub-run so a rerun never overwrites the
        // artifacts of the run it is being compared against.
        runId: repeat > 1 ? `${runId}/repeat-${attempt}` : runId,
        artifactsRoot,
        writeArtifacts,
        keepWorkspace,
        workspaceParent,
        onProgress,
      });
      results.push(repeat > 1 ? { ...result, repeat: attempt } : result);
    }
  }

  const report = {
    version: 1,
    runId,
    label,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    repeat,
    environment: await collectEnvironment({ driverName: driver.name, creds: driver.creds?.() ?? null }),
    summary: summarize(results),
    // Sorted so two reports of the same suite diff cleanly.
    results: [...results].sort((a, b) =>
      a.benchmarkId.localeCompare(b.benchmarkId) || (a.repeat ?? 0) - (b.repeat ?? 0)
    ),
  };

  if (writeArtifacts) await writeJson(path.join(runDir(runId, artifactsRoot), "summary.json"), report);
  return report;
}
