/**
 * services/sessionHooks.mjs
 *
 * Owns the SESSION-scoped hook lifecycle: Setup, SessionStart, SessionEnd.
 *
 * These are deliberately NOT in agent_loop.mjs. The loop runs once per turn, so
 * anything fired from there would fire per-turn (and Setup would fire per model
 * iteration) — the exact mis-wiring this module exists to prevent. The HTTP
 * route owns request/session lifecycle, and it calls into here.
 *
 * "Exactly once" semantics:
 *   Setup        — once per workspace, ever. Guarded by a marker file so it
 *                  survives restarts; this is bootstrap work (installing hooks,
 *                  seeding config), not per-session work.
 *   SessionStart — once per session per process. A brand-new session reports
 *                  source "startup"; an existing session first seen by this
 *                  process reports "resume" (mirroring Claude Code, where a
 *                  resumed session still gets SessionStart).
 *   SessionEnd   — once per session, with an explicit reason, and it still runs
 *                  when the session ends via error, abort, or server shutdown.
 */

import path from "path";
import { promises as fs } from "fs";

const SETUP_MARKER = ".setup-complete";

// sessionId → { workspacePath, userId, startedAt, runner }
const activeSessions = new Map();
// Workspaces whose Setup has been confirmed complete in THIS process (avoids
// re-stat'ing the marker on every request).
const setupChecked = new Set();
// Sessions whose SessionEnd already ran — end is idempotent by contract, since
// it can be reached from a delete route, an abort, and shutdown.
const endedSessions = new Set();

export function isSessionActive(sessionId) { return activeSessions.has(sessionId); }
export function activeSessionIds() { return [...activeSessions.keys()]; }

/**
 * Fire Setup once for a workspace. The marker is written only after the hooks
 * actually complete, so a crashed/failed setup retries on the next run rather
 * than being silently skipped forever.
 */
export async function ensureSetup({ workspacePath, fire }) {
  if (!workspacePath || setupChecked.has(workspacePath)) return { fired: false, reason: "already-checked" };

  const marker = path.join(workspacePath, ".kodo", SETUP_MARKER);
  try {
    await fs.access(marker);
    setupChecked.add(workspacePath);
    return { fired: false, reason: "already-setup" };
  } catch { /* not set up yet */ }

  const result = await fire("Setup", { workspacePath, cwd: workspacePath });

  // A blocking Setup hook means "this workspace is not ready" — do NOT write
  // the marker, so the next run tries again.
  if (result.decision === "block") {
    return { fired: true, blocked: true, reason: result.reason, result };
  }

  try {
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, `${new Date().toISOString()}\n`, "utf-8");
  } catch (err) {
    console.warn(`[SessionHooks] could not write setup marker: ${err.message}`);
  }
  setupChecked.add(workspacePath);
  return { fired: true, blocked: false, result };
}

/**
 * Fire SessionStart at most once per session per process.
 * `isNew` distinguishes a freshly created session from a resumed one.
 */
export async function ensureSessionStart({ sessionId, userId, workspacePath, isNew, fire, extra = {} }) {
  if (!sessionId) return { fired: false, reason: "no-session" };
  if (activeSessions.has(sessionId)) return { fired: false, reason: "already-started" };

  // Register BEFORE awaiting: two requests racing on the same new session must
  // not both fire SessionStart.
  activeSessions.set(sessionId, { workspacePath, userId, startedAt: Date.now() });
  endedSessions.delete(sessionId);

  const result = await fire("SessionStart", {
    session_id: sessionId,
    source: isNew ? "startup" : "resume",
    cwd: workspacePath,
    workspacePath,
    user_id: userId ?? null,
    ...extra,
  });

  return { fired: true, source: isNew ? "startup" : "resume", context: result.context, result };
}

/**
 * Fire SessionEnd exactly once. Safe to call from any termination path —
 * explicit delete, abort, error, or shutdown.
 *
 * `reason` mirrors Claude Code's exit reasons: clear | resume | logout |
 * prompt_input_exit | bypass_permissions_disabled | shutdown | error | other.
 */
export async function endSession({ sessionId, reason = "other", fire, extra = {} }) {
  if (!sessionId || endedSessions.has(sessionId)) return { fired: false, reason: "already-ended" };

  const session = activeSessions.get(sessionId);
  endedSessions.add(sessionId);
  activeSessions.delete(sessionId);

  // Any interaction still waiting on this session can never be answered now —
  // cancel it so the MCP server gets a reply instead of hanging forever.
  try {
    const { interactions } = await import("./interactionManager.mjs");
    const cancelled = interactions.cancelSession(sessionId, `session ended (${reason})`);
    if (cancelled) console.log(`[SessionHooks] cancelled ${cancelled} pending interaction(s) for ${sessionId}`);
  } catch { /* interaction manager unavailable — nothing to clean up */ }

  // A background subagent outlives its turn but NOT its session.
  try {
    const { cancelSessionTasks } = await import("./backgroundSubagents.mjs");
    const n = cancelSessionTasks(sessionId);
    if (n) console.log(`[SessionHooks] cancelled ${n} background subagent(s) for ${sessionId}`);
  } catch { /* module unavailable */ }

  // An ended session's clarifying answers must not carry into a later one.
  try {
    const { clearSessionAnswers } = await import("./sessionAnswers.mjs");
    clearSessionAnswers(sessionId);
  } catch { /* module unavailable */ }

  // Release this session's claim on the workspace config watcher. Refcounted:
  // the fs watch only closes when the LAST session on that workspace ends, so
  // a concurrent session is never left blind to config edits.
  if (session?.workspacePath) {
    try {
      const { releaseConfigWatcher } = await import("./configWatcher.mjs");
      releaseConfigWatcher(session.workspacePath, sessionId);
    } catch { /* watcher module unavailable */ }
  }

  // A session this process never started (e.g. deleted from another instance)
  // has no lifecycle to close.
  if (!session && !extra.force) return { fired: false, reason: "not-started-here" };

  const dispatch = fire || session?.runner?.fire;
  if (typeof dispatch !== "function") return { fired: false, reason: "no-runner" };

  try {
    const result = await dispatch("SessionEnd", {
      session_id: sessionId,
      reason,
      cwd: session?.workspacePath,
      workspacePath: session?.workspacePath,
      user_id: session?.userId ?? null,
      durationMs: session ? Date.now() - session.startedAt : null,
      ...extra,
    });
    return { fired: true, reason, result };
  } catch (err) {
    // Cleanup must never throw into a shutdown path.
    console.warn(`[SessionHooks] SessionEnd failed for ${sessionId}: ${err.message}`);
    return { fired: true, reason, error: String(err?.message || err) };
  }
}

// Remember how to dispatch for a session so shutdown can fire SessionEnd
// without an HTTP request in flight to build a runner.
export function attachRunner(sessionId, runner) {
  const s = activeSessions.get(sessionId);
  if (s) s.runner = runner;
}

/**
 * End every live session — for SIGINT/SIGTERM. Bounded so a slow hook cannot
 * hold the process open indefinitely during shutdown.
 */
export async function endAllSessions(reason = "shutdown", { timeoutMs = 5_000 } = {}) {
  const ids = activeSessionIds();
  if (!ids.length) return [];
  const work = Promise.all(ids.map((sessionId) => endSession({ sessionId, reason })));
  const timeout = new Promise((resolve) => {
    const t = setTimeout(() => resolve("timeout"), timeoutMs);
    t.unref?.();
  });
  const outcome = await Promise.race([work, timeout]);
  return outcome === "timeout" ? ids.map((id) => ({ sessionId: id, fired: false, reason: "shutdown-timeout" })) : outcome;
}

// Test-only: the module is process-global by design, so suites need a reset.
export function _resetSessionHookState() {
  activeSessions.clear();
  setupChecked.clear();
  endedSessions.clear();
}
