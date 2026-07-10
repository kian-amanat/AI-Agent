/**
 * multi_task_runner.mjs
 *
 * Claude Code multi-task approach:
 *   1. LLM decomposes the request into independent tasks (not regex — reasoning-based)
 *   2. Each task gets its own exploration loop (isolated iteration budget)
 *   3. Each task runs its own plan → execute → verify pipeline with isolated retryCount
 *   4. Final answer reports each task outcome separately
 *
 * Why this matters: a shared single-pass explore starves one subject of context when
 * there are 2+ independent file areas. Per-task isolation means task 1 succeeding
 * doesn't get re-touched if task 2 fails its retry.
 */

import path from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import OpenAI from "openai";
import { AIMessage } from "@langchain/core/messages";

import { agenticExploreNode } from "./agentic_explore.mjs";
import { planChangesNode }    from "./plan_changes.mjs";
import { executeChangesNode } from "./execute_changes.mjs";
import { verifyNode }         from "./verify.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const MAX_TASK_RETRIES = 2;

// ── Credential resolution ─────────────────────────────────────────────────────

function loadSettingsSync() {
  try {
    const p = path.join(__dirname, "../../data/settings.json");
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch { return {}; }
}

function resolveClientCredentials(modelRoute) {
  if (modelRoute?.ok && modelRoute?.apiKey && modelRoute?.model) {
    return { apiKey: modelRoute.apiKey, baseURL: modelRoute.baseUrl || "https://api.openai.com/v1", model: modelRoute.model };
  }
  const s = loadSettingsSync();
  if (s?.textApiKey && s?.textModel) return { apiKey: s.textApiKey, baseURL: s.textBaseUrl || "https://api.openai.com/v1", model: s.textModel };
  if (s?.apiKey && s?.model) return { apiKey: s.apiKey, baseURL: s.baseUrl || "https://api.openai.com/v1", model: s.model };
  return {
    apiKey: process.env.OPENAI_API_KEY || process.env.USER_API_KEY || "",
    baseURL: process.env.OPENAI_BASE_URL || process.env.USER_BASE_URL || "https://api.openai.com/v1",
    model: process.env.OPENAI_MODEL || process.env.USER_MODEL || "gpt-4o-mini",
  };
}

// ── LLM decomposition ─────────────────────────────────────────────────────────

/**
 * Decompose the user request into independent tasks using the LLM.
 * Returns [{description, scopeHint}] or null on failure.
 * "description" is a self-contained task instruction.
 * "scopeHint" is a likely filename or component area (used to bias exploration).
 */
async function decomposeRequest(userMessage, modelRoute) {
  const cleanMsg = String(userMessage).split(/conversation memory:/i)[0].trim();

  // Fast path: try regex BEFORE calling LLM.
  // For the most common pattern "do X, and do Y" the regex is instant (microseconds).
  // Only fall through to LLM for complex multi-task patterns the regex can't split.
  const quickMatch = cleanMsg.match(
    /^(.{10,120}),\s+(?:and\s+)?((?:create|make|add|fix|change|update|remove|improve|give|show|display|set|enable|build|implement|design|move|refactor|rewrite).{10,})$/i
  );
  if (quickMatch) {
    const tasks = [
      { description: quickMatch[1].trim(), scopeHint: "" },
      { description: quickMatch[2].trim(), scopeHint: "" },
    ];
    console.log(`[MultiTaskRunner] Regex decomposition (fast path, 0ms): ${tasks.length} task(s)`);
    return tasks;
  }

  // LLM decomposition for complex patterns the regex can't handle.
  const { apiKey, baseURL, model } = resolveClientCredentials(modelRoute);
  if (!apiKey) return null;

  const client = new OpenAI({ apiKey, baseURL, timeout: 60_000, maxRetries: 0 });

  const system = `You are a task decomposer for a code editor AI agent.

Given a user request, split it into independent coding tasks. Each task must target a distinct file or UI concern — something that can be explored and executed separately without affecting the other tasks.

Rules:
- If the request is genuinely single-task (one file, one change), return exactly one task.
- If there are 2+ clearly independent parts (different components, different pages, different features), return them as separate tasks.
- Each "description" must be self-contained — a complete instruction the agent can act on without reading the other tasks.
- "scopeHint": the most likely file basename or component name (e.g. "ChatSidebar.tsx", "page.tsx", "EmptyStateCard.tsx").

Return ONLY valid JSON (no markdown fences):
{"tasks":[{"description":"...","scopeHint":"..."}]}`;

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `User request: "${cleanMsg}"` },
      ],
      temperature: 0,
      max_tokens: 600,
    });
    const raw = String(response.choices?.[0]?.message?.content || "").trim()
      .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const start = raw.indexOf("{"); const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (Array.isArray(parsed?.tasks) && parsed.tasks.length > 0) {
      console.log(`[MultiTaskRunner] LLM decomposed: ${parsed.tasks.length} task(s)`, parsed.tasks.map(t => t.description?.slice(0, 60)));
      return parsed.tasks;
    }
  } catch (err) {
    console.warn("[MultiTaskRunner] LLM decomposition failed:", String(err.message || err).slice(0, 120));
  }

  return null;
}

// ── Per-task pipeline ─────────────────────────────────────────────────────────

/**
 * Run the full explore → plan → execute → verify pipeline for one task.
 * Returns {ok, finalAnswer, executionResults, error}.
 */
async function runOneTask({ taskIndex, taskTotal, taskDescription, scopeHint, baseState, emit }) {
  emit?.({
    type: "progress",
    stage: "task_start",
    message: `📋 Task ${taskIndex + 1}/${taskTotal}: ${taskDescription.slice(0, 80)}`,
  });

  // Build task-scoped message — append scope hint so exploration targets the right area
  const taskMessage = scopeHint
    ? `${taskDescription}\n\n[File hint: ${scopeHint}]`
    : taskDescription;

  // Task-isolated state — no shared fileContext or retryCount.
  const originalMessage = String(baseState.userMessage || "").split(/conversation memory:/i)[0].trim();
  let taskState = {
    ...baseState,
    userMessage:      taskMessage,
    nameMatchMessage: originalMessage,
    intent:           "explore",
    fileContext:      [],
    investigation:    null,
    plan:             [],
    executionResults: [],
    verifyResult:     null,
    retryCount:       0,
  };

  // ── Step 1: Explore ───────────────────────────────────────────────────────
  try {
    const exploreResult = await agenticExploreNode(taskState);
    taskState = { ...taskState, ...exploreResult };
    console.log(`[MultiTaskRunner] Task ${taskIndex + 1} explore done: ${(taskState.fileContext || []).length} file(s)`);

    // If explore bailed early (API error → 0 files), skip planning — there's nothing to work with.
    if ((taskState.fileContext || []).length === 0 && exploreResult.finalAnswer) {
      return { ok: false, error: exploreResult.finalAnswer, executionResults: [] };
    }
  } catch (err) {
    const error = `Explore failed: ${err.message}`;
    console.error(`[MultiTaskRunner] Task ${taskIndex + 1} explore error:`, err.message);
    return { ok: false, error, executionResults: [] };
  }

  // ── Step 2: Plan → Execute → Verify (with per-task retry) ─────────────────
  let taskOk    = false;
  let taskError = null;
  const allExecResults = [];

  for (let attempt = 0; attempt <= MAX_TASK_RETRIES; attempt++) {
    if (baseState.abortSignal?.aborted) break;

    if (attempt > 0) {
      emit?.({
        type: "progress",
        stage: "task_retry",
        message: `🔄 Task ${taskIndex + 1}: retry ${attempt}/${MAX_TASK_RETRIES}…`,
      });
    }

    // Plan
    let planResult;
    try {
      planResult = await planChangesNode({ ...taskState, retryCount: attempt });
      taskState  = { ...taskState, ...planResult, retryCount: attempt };
    } catch (err) {
      taskError = `Plan failed: ${err.message}`;
      console.error(`[MultiTaskRunner] Task ${taskIndex + 1} plan error:`, err.message);
      break;
    }

    // If plan is all read_only on the FIRST attempt, escalate to rewrite on next pass.
    // On subsequent attempts (retryCount >= 1) the planner is already in rewrite mode —
    // if it still returns read_only, give up.
    const actionable = (taskState.plan || []).filter(s => s.action !== "read_only");
    if (actionable.length === 0) {
      if (attempt === 0) {
        console.log(`[MultiTaskRunner] Task ${taskIndex + 1}: all read_only on attempt 0 — escalating to rewrite`);
        taskState = { ...taskState, retryCount: 1 }; // signal escalation to buildSystemPrompt
        continue;
      }
      const readOnlyDesc = (taskState.plan || []).find(s => s.action === "read_only")?.description || "";
      console.log(`[MultiTaskRunner] Task ${taskIndex + 1}: all read_only after escalation — ${readOnlyDesc.slice(0, 80)}`);
      taskOk    = false;
      taskError = readOnlyDesc || "No actionable changes found";
      break;
    }

    // Execute
    let execResult;
    try {
      execResult = await executeChangesNode({ ...taskState, retryCount: attempt });
      taskState  = { ...taskState, ...execResult, retryCount: attempt };
      allExecResults.push(...(execResult.executionResults || []));
    } catch (err) {
      taskError = `Execute failed: ${err.message}`;
      console.error(`[MultiTaskRunner] Task ${taskIndex + 1} execute error:`, err.message);
      break;
    }

    // Verify
    let verifyResult;
    try {
      verifyResult = await verifyNode({ ...taskState, retryCount: attempt });
      taskState    = { ...taskState, ...verifyResult };
    } catch (err) {
      taskError = `Verify failed: ${err.message}`;
      console.error(`[MultiTaskRunner] Task ${taskIndex + 1} verify error:`, err.message);
      break;
    }

    if (verifyResult.verifyResult?.ok) {
      taskOk = true;
      break;
    }

    // Verify failed — update fileContext for retry if available, then loop
    taskError = (verifyResult.verifyResult?.issues || []).join("; ") || "Verification failed";
    if (attempt < MAX_TASK_RETRIES && verifyResult.fileContext?.length) {
      taskState.fileContext = verifyResult.fileContext;
      console.log(`[MultiTaskRunner] Task ${taskIndex + 1} verify failed — retry with updated fileContext`);
    } else if (attempt >= MAX_TASK_RETRIES) {
      console.warn(`[MultiTaskRunner] Task ${taskIndex + 1} max retries exhausted`);
    }
  }

  const statusEmoji = taskOk ? "✅" : "⚠️";
  emit?.({
    type: "progress",
    stage: "task_done",
    message: `${statusEmoji} Task ${taskIndex + 1}: ${taskOk ? "done" : `failed — ${taskError?.slice(0, 60) || "unknown"}`}`,
  });

  return { ok: taskOk, error: taskError, executionResults: allExecResults };
}

// ── Main node ─────────────────────────────────────────────────────────────────

export async function multiTaskRunnerNode(state) {
  const { userMessage, modelRoute, emit, abortSignal } = state;

  emit?.({ type: "progress", stage: "decomposing", message: "🧩 Understanding tasks…" });

  // Step 1: LLM-based decomposition
  const tasks = await decomposeRequest(userMessage, modelRoute);

  // If decomposition failed or returned a single task, run the normal single-task pipeline
  if (!tasks || tasks.length <= 1) {
    console.log("[MultiTaskRunner] Single task — running normal pipeline");
    emit?.({ type: "progress", stage: "exploring", message: "📂 Exploring workspace…" });

    let s = { ...state, intent: "explore", retryCount: 0 };

    const exploreResult = await agenticExploreNode(s);
    s = { ...s, ...exploreResult };

    const planResult = await planChangesNode(s);
    s = { ...s, ...planResult };

    const execResult = await executeChangesNode(s);
    s = { ...s, ...execResult };

    const verifyResult = await verifyNode(s);

    // If verify failed and we can retry, do one re-plan cycle
    if (!verifyResult.verifyResult?.ok && verifyResult.fileContext?.length) {
      s = { ...s, ...verifyResult, retryCount: 1 };
      const retryPlan   = await planChangesNode(s);
      s = { ...s, ...retryPlan };
      const retryExec   = await executeChangesNode(s);
      s = { ...s, ...retryExec };
      const retryVerify = await verifyNode({ ...s, retryCount: 1 });
      return { ...exploreResult, ...retryPlan, ...retryExec, ...retryVerify };
    }

    return { ...exploreResult, ...planResult, ...execResult, ...verifyResult };
  }

  // Step 2: Multiple tasks — parallel explore, sequential execute
  // Exploration is read-only so running it concurrently is safe.
  // Plan/execute/verify is sequential to avoid concurrent writes to the same file.
  console.log(`[MultiTaskRunner] Running ${tasks.length} tasks — parallel explore, sequential execute`);
  emit?.({
    type: "progress",
    stage: "decomposed",
    message: `🧩 ${tasks.length} tasks: ${tasks.map((t, i) => `(${i + 1}) ${t.description.slice(0, 35)}`).join(" · ")}`,
  });

  const originalCleanMsg = String(userMessage || "").split(/conversation memory:/i)[0].trim();

  // ── Phase 1: Explore all tasks concurrently ──────────────────────────────
  emit?.({ type: "progress", stage: "exploring", message: "📂 Exploring all tasks in parallel…" });

  const exploredStates = await Promise.all(tasks.map(async (task, i) => {
    if (abortSignal?.aborted) return { ok: false, error: "Aborted", taskState: null };

    const taskMessage = task.scopeHint
      ? `${task.description}\n\n[File hint: ${task.scopeHint}]`
      : task.description;

    let ts = {
      ...state,
      userMessage:      taskMessage,
      nameMatchMessage: originalCleanMsg, // use original user words for name-match
      intent:           "explore",
      fileContext:      [],
      investigation:    null,
      plan:             [],
      executionResults: [],
      verifyResult:     null,
      retryCount:       0,
    };

    try {
      const exploreResult = await agenticExploreNode(ts);
      ts = { ...ts, ...exploreResult };
      console.log(`[MultiTaskRunner] Task ${i + 1} explore done: ${(ts.fileContext || []).length} file(s)`);

      if ((ts.fileContext || []).length === 0 && exploreResult.finalAnswer) {
        return { ok: false, error: exploreResult.finalAnswer, taskState: ts };
      }
      return { ok: true, taskState: ts };
    } catch (err) {
      console.error(`[MultiTaskRunner] Task ${i + 1} explore error:`, err.message);
      return { ok: false, error: `Explore failed: ${err.message}`, taskState: ts };
    }
  }));

  // ── Phase 2a: Plan all tasks in parallel ────────────────────────────────
  // Plans are pure read + LLM inference — no file writes, safe to parallelize.
  emit?.({ type: "progress", stage: "planning", message: "🧠 Planning all tasks in parallel…" });

  const plannedStates = await Promise.all(exploredStates.map(async (ex, i) => {
    if (!ex.ok || abortSignal?.aborted) return { ...ex };
    try {
      const planResult = await planChangesNode({ ...ex.taskState, retryCount: 0 });
      const ts = { ...ex.taskState, ...planResult, retryCount: 0 };
      const actionable = (ts.plan || []).filter(s => s.action !== "read_only");
      // Flag all-read_only plans so the execute phase can re-plan with escalation
      return { ok: true, taskState: { ...ts, _escalate: actionable.length === 0 } };
    } catch (err) {
      console.warn(`[MultiTaskRunner] Task ${i + 1} plan error:`, err.message);
      return { ok: false, error: `Plan failed: ${err.message}`, taskState: ex.taskState };
    }
  }));

  // ── Phase 2b: Execute + Verify sequentially ──────────────────────────────
  // File writes must be sequential to avoid concurrent edits to the same file.
  const taskOutcomes  = [];
  const allExecResults = [];

  for (let i = 0; i < tasks.length; i++) {
    if (abortSignal?.aborted) break;

    const planned = plannedStates[i];

    if (!planned.ok) {
      emit?.({ type: "progress", stage: "task_done", message: `⚠️ Task ${i + 1}: failed` });
      taskOutcomes.push({ description: tasks[i].description, ok: false, error: planned.error, executionResults: [] });
      continue;
    }

    emit?.({
      type: "progress",
      stage: "task_start",
      message: `📋 Task ${i + 1}/${tasks.length}: ${tasks[i].description.slice(0, 80)}`,
    });

    let taskState = planned.taskState;
    let taskOk    = false;
    let taskError = null;
    const thisExecResults = [];

    // If the parallel plan was all read_only, do one escalated re-plan before the loop
    if (taskState._escalate) {
      taskState = { ...taskState, retryCount: 1, _escalate: false };
      try {
        const replan = await planChangesNode({ ...taskState });
        taskState = { ...taskState, ...replan, retryCount: 1 };
      } catch (err) {
        taskError = `Plan failed: ${err.message}`;
        taskOutcomes.push({ description: tasks[i].description, ok: false, error: taskError, executionResults: [] });
        continue;
      }
    }

    // Retry loop — attempt 0 uses the pre-computed plan, retries re-plan from scratch
    for (let attempt = 0; attempt <= MAX_TASK_RETRIES; attempt++) {
      if (abortSignal?.aborted) break;

      // On retry, re-plan with updated fileContext from verify
      if (attempt > 0) {
        emit?.({ type: "progress", stage: "task_retry", message: `🔄 Task ${i + 1}: retry ${attempt}/${MAX_TASK_RETRIES}…` });
        try {
          const replan = await planChangesNode({ ...taskState, retryCount: attempt });
          taskState = { ...taskState, ...replan, retryCount: attempt };
        } catch (err) {
          taskError = `Plan failed: ${err.message}`;
          break;
        }
      }

      const actionable = (taskState.plan || []).filter(s => s.action !== "read_only");
      if (actionable.length === 0) {
        const readOnlyDesc = (taskState.plan || []).find(s => s.action === "read_only")?.description || "";
        // "Already exists" is not a real failure — treat as ok
        const alreadyExists = /already (exist|implement|done|there|present)/i.test(readOnlyDesc);
        taskOk    = alreadyExists;
        taskError = alreadyExists ? null : (readOnlyDesc || "No actionable changes found");
        break;
      }

      let execResult;
      try {
        execResult = await executeChangesNode({ ...taskState, retryCount: attempt });
        taskState  = { ...taskState, ...execResult, retryCount: attempt };
        thisExecResults.push(...(execResult.executionResults || []));
      } catch (err) {
        taskError = `Execute failed: ${err.message}`;
        break;
      }

      let verResult;
      try {
        verResult = await verifyNode({ ...taskState, retryCount: attempt });
        taskState  = { ...taskState, ...verResult };
      } catch (err) {
        taskError = `Verify failed: ${err.message}`;
        break;
      }

      if (verResult.verifyResult?.ok) { taskOk = true; break; }

      taskError = (verResult.verifyResult?.issues || []).join("; ") || "Verification failed";
      if (attempt < MAX_TASK_RETRIES && verResult.fileContext?.length) {
        taskState.fileContext = verResult.fileContext;
      }
    }

    const statusEmoji = taskOk ? "✅" : "⚠️";
    emit?.({
      type: "progress",
      stage: "task_done",
      message: `${statusEmoji} Task ${i + 1}: ${taskOk ? "done" : `failed — ${taskError?.slice(0, 60) || "unknown"}`}`,
    });

    taskOutcomes.push({ description: tasks[i].description, ok: taskOk, error: taskError, executionResults: thisExecResults });
    allExecResults.push(...thisExecResults);
  }

  // Step 3: Per-task final answer
  const summaryLines = taskOutcomes.map((t, i) =>
    `${t.ok ? "✅" : "⚠️"} Task ${i + 1}: ${t.description} — ${t.ok ? "Done" : (t.error?.slice(0, 100) || "failed")}`
  );
  const finalAnswer = summaryLines.join("\n");
  const allOk = taskOutcomes.every(t => t.ok);

  emit?.({
    type: "progress",
    stage: "verified",
    message: allOk
      ? `✅ All ${tasks.length} tasks completed!`
      : `⚠️ ${taskOutcomes.filter(t => !t.ok).length}/${tasks.length} task(s) had issues`,
  });

  console.log(`[MultiTaskRunner] Done: ${taskOutcomes.filter(t => t.ok).length}/${tasks.length} succeeded`);

  return {
    finalAnswer,
    executionResults: allExecResults,
    verifyResult: {
      ok: allOk,
      issues: taskOutcomes.filter(t => !t.ok).map(t => `${t.description}: ${t.error || "failed"}`),
    },
    messages: [new AIMessage(finalAnswer)],
  };
}
