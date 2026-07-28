#!/usr/bin/env node
/**
 * eval/run.mjs — live eval harness (Priority 2 from the earlier scoring
 * conversation: a repeatable, systematic way to catch agent-BEHAVIOR
 * regressions, instead of only ever finding them reactively from a user's
 * pasted transcript).
 *
 * Unlike tests/*.test.mjs (fast, offline, fake credentials, unit-level),
 * this calls the REAL graph (router → answer/agent_loop) against a REAL
 * configured model, in a throwaway fixture workspace per task. That means:
 *   - it costs real money and real time (several LLM calls per task)
 *   - it is NOT deterministic — a flaky/failing task might just mean "the
 *     model didn't do it this time," not "the code regressed"
 *   - it is NOT part of `npm test` / CI — run it manually on demand
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... DEFAULT_MODEL=gpt-4o-mini node eval/run.mjs
 *   node eval/run.mjs run-dev-server           # run just one task
 *
 * Credentials: same resolution as the real server (resolveCreds) — reads
 * OPENAI_API_KEY / OPENAI_BASE_URL / DEFAULT_MODEL from the environment if
 * no DB-backed settings.json is present. Nothing here talks to the DB.
 */

import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { runKodoGraph } from "../services/graph_runner.mjs";
import { tasks } from "./tasks.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function checkCredentialsConfigured() {
  if (process.env.OPENAI_API_KEY) return true;
  console.error(
    "No OPENAI_API_KEY in the environment, and this harness doesn't read the DB-backed " +
    "settings the real server can fall back to. Set at least:\n" +
    "  OPENAI_API_KEY=sk-...\n" +
    "  DEFAULT_MODEL=gpt-4o-mini   (optional — defaults applied by resolveCreds otherwise)\n" +
    "  OPENAI_BASE_URL=...         (optional, for a non-OpenAI-compatible gateway)\n" +
    "before running eval/run.mjs — it makes real, billed API calls."
  );
  return false;
}

async function runTask(task) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `kodo-eval-${task.id}-`));
  const events = [];
  const askUserCalls = [];

  try {
    if (task.setupWorkspace) await task.setupWorkspace(dir);

    const emit = (e) => events.push(e);
    const askUser = async ({ question, header, options }) => {
      askUserCalls.push({ question, header, options });
      // No human present. Resolve promptly so the run doesn't hang — the
      // POINT of this task is checking that it asked, not what it does next.
      return "(eval harness: no human available to answer — proceed with your best judgment)";
    };

    const startedAt = Date.now();
    const result = await runKodoGraph({
      userMessage: task.prompt,
      sessionId: `eval_${task.id}`,
      requestId: `eval_${task.id}_${Date.now()}`,
      userId: "eval",
      workspacePath: dir,
      modelRoute: null, // resolveCreds falls back to plain env vars
      emit,
      permissionMode: "auto", // no human to approve an "ask"-mode gate
      askUser,
    });
    const durationMs = Date.now() - startedAt;

    const checks = task.checks ? await task.checks({ dir, result, events, askUserCalls }) : [];
    return { task, result, events, askUserCalls, durationMs, checks, error: null };
  } catch (err) {
    return { task, result: null, events, askUserCalls, durationMs: null, checks: [], error: err };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function printTaskReport(run) {
  const { task, durationMs, checks, error } = run;
  console.log(`\n── ${task.id} ${"─".repeat(Math.max(0, 60 - task.id.length))}`);
  console.log(`   ${task.description}`);
  if (error) {
    console.log(`   ❌ THREW: ${String(error?.message || error).slice(0, 300)}`);
    return false;
  }
  console.log(`   (${durationMs}ms, ${run.result?.usage?.llmCalls ?? "?"} LLM call(s))`);
  let allPassed = true;
  for (const c of checks) {
    console.log(`   ${c.pass ? "✅" : "❌"} ${c.name}${c.pass || !c.detail ? "" : ` — ${c.detail}`}`);
    if (!c.pass) allPassed = false;
  }
  return allPassed;
}

async function main() {
  if (!checkCredentialsConfigured()) process.exit(1);

  const requestedId = process.argv[2];
  const selected = requestedId ? tasks.filter((t) => t.id === requestedId) : tasks;
  if (requestedId && selected.length === 0) {
    console.error(`No task named "${requestedId}". Available: ${tasks.map((t) => t.id).join(", ")}`);
    process.exit(1);
  }

  console.log(`Running ${selected.length} eval task(s) against a real model — this makes real API calls and may take a while.\n`);

  let passedCount = 0;
  for (const task of selected) {
    const run = await runTask(task);
    const passed = printTaskReport(run);
    if (passed) passedCount++;
  }

  console.log(`\n${"═".repeat(70)}`);
  console.log(`${passedCount}/${selected.length} task(s) fully passed`);
  console.log(`${"═".repeat(70)}\n`);
  process.exit(passedCount === selected.length ? 0 : 1);
}

main();
