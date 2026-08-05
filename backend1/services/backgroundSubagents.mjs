/**
 * services/backgroundSubagents.mjs
 *
 * Real background execution for subagents.
 *
 * "Background" means the spawning tool call RETURNS IMMEDIATELY with a task id
 * while the subagent keeps running on its own promise chain. The foreground
 * turn is never blocked and never awaits it. That is the whole distinction
 * from a delayed inline call: the main loop continues issuing tool calls and
 * talking to the model while the task is still executing.
 *
 * Bounded on purpose: a model that spawns background agents in a loop must not
 * be able to open unbounded concurrent work.
 *
 * Nothing here touches parent conversation state. A background task's result
 * is retrievable only by explicit query, so it can never splice itself into a
 * conversation it isn't part of.
 */

import crypto from "crypto";

const MAX_CONCURRENT = 4;   // simultaneously running
const MAX_TRACKED = 50;     // completed records retained for querying
const DEFAULT_TTL_MS = 30 * 60 * 1000;

const tasks = new Map(); // taskId → record

function prune() {
  if (tasks.size <= MAX_TRACKED) return;
  const finished = [...tasks.values()]
    .filter((t) => t.status !== "running")
    .sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
  for (const t of finished) {
    if (tasks.size <= MAX_TRACKED) break;
    tasks.delete(t.taskId);
  }
}

export function runningCount() {
  return [...tasks.values()].filter((t) => t.status === "running").length;
}

/**
 * Start a subagent in the background.
 *
 * `run` is an async function returning the subagent's report. It is invoked
 * immediately but NOT awaited — the caller gets a task id straight back.
 * `onSettled` runs after completion for cleanup (worktree removal), and its
 * own failure is recorded rather than thrown into an unattached promise.
 */
export function startBackgroundSubagent({
  run, onSettled = null, agentType, subagentId,
  sessionId = null, requestId = null, worktreePath = null, ttlMs = DEFAULT_TTL_MS,
}) {
  if (runningCount() >= MAX_CONCURRENT) {
    return { ok: false, error: `Too many background subagents already running (limit ${MAX_CONCURRENT}). Wait for one to finish.` };
  }

  const taskId = `bg_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const controller = new AbortController();
  const record = {
    taskId, agentType, subagentId, sessionId, requestId, worktreePath,
    status: "running", startedAt: Date.now(), finishedAt: null,
    result: null, error: null, cleanup: null, controller,
  };
  tasks.set(taskId, record);
  prune();

  const ttl = setTimeout(() => {
    if (record.status === "running") controller.abort();
  }, ttlMs);
  ttl.unref?.();

  // Detached chain. Deliberately not awaited and not returned to the caller.
  (async () => {
    try {
      record.result = await run(controller.signal);
      record.status = controller.signal.aborted ? "cancelled" : "done";
    } catch (err) {
      record.status = "error";
      record.error = String(err?.message || err).slice(0, 500);
    } finally {
      clearTimeout(ttl);
      record.finishedAt = Date.now();
      // Cleanup must run on EVERY outcome, and must not resurrect the error.
      if (onSettled) {
        try { record.cleanup = await onSettled(record); }
        catch (err) { record.cleanup = { ok: false, error: String(err?.message || err) }; }
      }
    }
  })();

  return { ok: true, taskId, record: publicView(record) };
}

function publicView(r) {
  // `controller` and the raw promise are intentionally not exposed.
  return {
    taskId: r.taskId, agentType: r.agentType, subagentId: r.subagentId,
    sessionId: r.sessionId, requestId: r.requestId,
    status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt,
    durationMs: r.finishedAt ? r.finishedAt - r.startedAt : Date.now() - r.startedAt,
    worktreePath: r.worktreePath,
    result: r.status === "done" ? r.result : null,
    error: r.error,
    cleanup: r.cleanup,
  };
}

export function getBackgroundTask(taskId) {
  const r = tasks.get(taskId);
  return r ? publicView(r) : null;
}

export function listBackgroundTasks(sessionId = null) {
  return [...tasks.values()]
    .filter((r) => !sessionId || r.sessionId === sessionId)
    .map(publicView)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function cancelBackgroundTask(taskId) {
  const r = tasks.get(taskId);
  if (!r || r.status !== "running") return false;
  r.controller.abort();
  return true;
}

export function cancelSessionTasks(sessionId) {
  let n = 0;
  for (const r of tasks.values()) {
    if (r.sessionId === sessionId && r.status === "running") { r.controller.abort(); n++; }
  }
  return n;
}

/** Abort everything — for shutdown. Waits briefly so cleanup can run. */
export async function shutdownBackgroundSubagents({ graceMs = 2_000 } = {}) {
  const running = [...tasks.values()].filter((t) => t.status === "running");
  for (const r of running) r.controller.abort();
  if (!running.length) return { aborted: 0 };
  await new Promise((resolve) => { const t = setTimeout(resolve, graceMs); t.unref?.(); });
  return { aborted: running.length };
}

export function _resetBackgroundSubagents() { tasks.clear(); }
