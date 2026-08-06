/**
 * bench/replay.mjs
 * Reads a replay artifact back and reconstructs the run for a human.
 *
 * The point of the artifact format is that debugging a failed benchmark never
 * requires re-running it (which costs money, takes minutes, and — against a
 * real model — may not reproduce at all). Everything needed is on disk:
 * the prompt, the ordered event stream, every tool call with its arguments and
 * output, the final answer, which files really changed and what they now
 * contain, the verification the controller actually observed, and the checks
 * that decided the outcome.
 */

import fs from "fs/promises";
import path from "path";
import { benchRunsRoot, benchmarkArtifactDir } from "./paths.mjs";

export async function loadReplay(fileOrDir) {
  const stat = await fs.stat(fileOrDir).catch(() => null);
  const file = stat?.isDirectory() ? path.join(fileOrDir, "replay.json") : fileOrDir;
  const replay = JSON.parse(await fs.readFile(file, "utf-8"));
  if (replay?.version !== 1) throw new Error(`${file} is not a v1 replay artifact`);
  return replay;
}

/** Locate a benchmark's replay artifact inside a run. */
export function replayPath(runId, benchmarkId, root = benchRunsRoot) {
  return path.join(benchmarkArtifactDir(runId, benchmarkId, root), "replay.json");
}

function short(str, max) {
  const s = String(str ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Render a replay as an ordered, readable trace.
 * @param {object} replay
 * @param {{verbose?: boolean}} opts  verbose prints full tool args and outputs
 */
export function formatReplay(replay, { verbose = false } = {}) {
  const r = replay.result;
  const lines = [];
  lines.push("");
  lines.push("═".repeat(78));
  lines.push(`  REPLAY  ${replay.benchmark.id}  →  ${r.outcome.toUpperCase()}  (score ${r.score})`);
  lines.push("═".repeat(78));
  lines.push(`  ${replay.benchmark.metadata.title}`);
  lines.push(`  difficulty=${replay.benchmark.metadata.difficulty} golden=${replay.benchmark.metadata.golden} capabilities=${replay.benchmark.metadata.capabilities.join(",")}`);
  lines.push("");
  lines.push("  ── prompt ".padEnd(78, "─"));
  for (const l of replay.benchmark.prompt.split("\n")) lines.push(`  │ ${l}`);
  lines.push("");

  if (r.blocker) {
    lines.push(`  🚧 BLOCKED at ${r.blocker.stage}: ${r.blocker.message}`);
    lines.push("");
  }

  lines.push("  ── tool timeline ".padEnd(78, "─"));
  if (!replay.timeline.length) {
    lines.push("     (no tool calls — the agent never touched the workspace)");
  }
  for (const call of replay.timeline) {
    const status = call.status === "error" ? "✗" : "✓";
    lines.push(`  ${String(call.seq).padStart(4)} ${status} ${call.toolName}(${short(JSON.stringify(call.args), verbose ? 100_000 : 120)})  ${call.durationMs ?? "?"}ms`);
    if (verbose) {
      for (const l of String(call.output ?? "").split("\n").slice(0, 60)) lines.push(`         │ ${l}`);
    } else if (call.status === "error") {
      lines.push(`         │ ${short(call.output, 200)}`);
    }
  }
  lines.push("");

  if (replay.askUserCalls.length) {
    lines.push("  ── questions asked of the user ".padEnd(78, "─"));
    for (const q of replay.askUserCalls) {
      lines.push(`  ${String(q.seq).padStart(4)} ❓ ${q.question}`);
      lines.push(`         answered: ${short(q.answer, 160)}`);
    }
    lines.push("");
  }

  lines.push("  ── what actually changed on disk ".padEnd(78, "─"));
  const ch = r.workspaceChanges;
  for (const f of ch.added) lines.push(`     + ${f}`);
  for (const f of ch.modified) lines.push(`     ~ ${f}`);
  for (const f of ch.deleted) lines.push(`     - ${f}`);
  if (!ch.changed.length) lines.push("     (nothing changed)");
  if (r.reportMatchesDisk === false) {
    lines.push(`     ⚠️  the agent reported editing [${r.agentReportedFiles.join(", ")}] — that does not match the disk`);
  }
  lines.push("");

  const ctrl = r.metrics?.controller;
  lines.push("  ── run metrics ".padEnd(78, "─"));
  lines.push(`     exitReason=${r.metrics?.exitReason ?? "?"}  iterations=${r.metrics?.iterations ?? "?"}  stoppedEarly=${r.metrics?.stoppedEarly ?? "?"}`);
  lines.push(`     controller stopReason=${ctrl?.stopReason ?? "(none)"}  state=${ctrl?.state ?? "?"}  phase=${ctrl?.phase ?? "?"}`);
  lines.push(`     tokens=${(r.usage?.inputTokens ?? 0)}in/${(r.usage?.outputTokens ?? 0)}out  llmCalls=${r.usage?.llmCalls ?? 0}  duration=${(r.durationMs / 1000).toFixed(1)}s`);
  lines.push(`     verification: ran=${ctrl?.verificationRan ?? false} passed=${ctrl?.verificationPassed ?? false} currentlyValid=${ctrl?.verificationCurrent ?? false} stale=${ctrl?.verificationStale ?? false}`);
  for (const v of ctrl?.verifications ?? []) lines.push(`        ${v.passed ? "✓" : "✗"} ${v.command}`);
  lines.push("");

  lines.push("  ── final answer ".padEnd(78, "─"));
  for (const l of String(r.finalAnswer || "(none)").split("\n")) lines.push(`  │ ${l}`);
  if (r.falsePositive) {
    lines.push("");
    lines.push("  ⚠️  FALSE POSITIVE: the answer above claims success, the workspace does not support it.");
  }
  lines.push("");

  lines.push("  ── checks ".padEnd(78, "─"));
  for (const c of r.checks ?? []) {
    lines.push(`     ${c.pass ? "✓" : "✗"} ${c.critical ? "" : "(optional) "}${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  lines.push("");
  lines.push("  ── expected ".padEnd(78, "─"));
  for (const l of replay.benchmark.expected.split("\n")) lines.push(`  │ ${l}`);
  lines.push("═".repeat(78));
  lines.push("");
  return lines.join("\n");
}
