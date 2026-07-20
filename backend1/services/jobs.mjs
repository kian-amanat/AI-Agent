/**
 * services/jobs.mjs
 * In-memory registry of background agent runs.
 *
 * The point: an agent task must survive the HTTP request that started it, so a
 * user can refresh the page, switch sessions, or briefly lose connection and
 * the work keeps going. A "job" owns the run's lifecycle; HTTP requests are
 * just transient *subscribers* to its event stream.
 *
 * A job buffers every event it emits so a (re)connecting client can replay
 * what it missed, then receive live events. Finished jobs are kept briefly so a
 * client that reconnects right after completion still sees the final result,
 * then garbage-collected.
 *
 * This registry is process-local: a server restart loses it (db.mjs marks any
 * DB-recorded "running" job as "interrupted" on boot to keep the UI honest).
 */

const jobs = new Map(); // requestId → Job

const MAX_BUFFERED_EVENTS = 2000;   // hard cap so a runaway run can't grow forever
const FINISHED_TTL_MS = 5 * 60_000; // keep a finished job replayable for 5 min

function now() { return Date.now(); }

/**
 * createJob — register a new background run.
 * The caller then drives it: call job.emit(event) for each SSE event, and
 * job.finish(status) when the run ends. controller is the AbortController the
 * run honors so cancel() can stop it.
 */
export function createJob({ requestId, sessionId, userId, controller, title = "" }) {
  const job = {
    requestId,
    sessionId,
    userId,
    title,
    status: "running", // running | done | error | cancelled
    controller: controller || null,
    events: [],        // buffered events for replay
    subscribers: new Set(), // Set<(event) => void>
    createdAt: now(),
    finishedAt: null,
    gcTimer: null,
  };
  jobs.set(requestId, job);
  return job;
}

/** Push an event into the job: buffer it (capped) and fan out to live subscribers. */
export function emitToJob(requestId, event) {
  const job = jobs.get(requestId);
  if (!job) return;
  job.events.push(event);
  if (job.events.length > MAX_BUFFERED_EVENTS) {
    // Drop the oldest non-critical events; always keep the very first (start).
    job.events.splice(1, job.events.length - MAX_BUFFERED_EVENTS);
  }
  for (const fn of job.subscribers) {
    try { fn(event); } catch { /* a dead subscriber must not break the others */ }
  }
}

/**
 * subscribe — attach a live listener to a job. Immediately replays every
 * buffered event (so a reconnecting client catches up), then streams new ones.
 * Returns an unsubscribe function. Unsubscribing does NOT stop the job — that's
 * the whole point (client disconnects, work continues).
 */
export function subscribe(requestId, onEvent) {
  const job = jobs.get(requestId);
  if (!job) return null;
  for (const ev of job.events) {
    try { onEvent(ev); } catch { /* ignore */ }
  }
  // Already finished: the replay above included the terminal event; nothing
  // live will follow, so hand back a no-op unsubscribe.
  if (job.status !== "running") return () => {};
  job.subscribers.add(onEvent);
  return () => job.subscribers.delete(onEvent);
}

/** Mark a job finished, flush nothing more, and schedule GC. */
export function finishJob(requestId, status = "done") {
  const job = jobs.get(requestId);
  if (!job) return;
  job.status = status;
  job.finishedAt = now();
  job.subscribers.clear();
  if (job.gcTimer) clearTimeout(job.gcTimer);
  job.gcTimer = setTimeout(() => jobs.delete(requestId), FINISHED_TTL_MS);
  if (job.gcTimer.unref) job.gcTimer.unref(); // don't keep the process alive for GC
}

/** Request cancellation of a running job (aborts its controller). */
export function cancelJob(requestId) {
  const job = jobs.get(requestId);
  if (!job || job.status !== "running") return false;
  try { job.controller?.abort(); } catch { /* ignore */ }
  return true;
}

export function getJob(requestId) {
  return jobs.get(requestId) || null;
}

/** Live running jobs for a user (optionally one session), for reconnect discovery. */
export function getRunningJobs(userId, sessionId = null) {
  const out = [];
  for (const job of jobs.values()) {
    if (job.userId !== userId) continue;
    if (job.status !== "running") continue;
    if (sessionId && job.sessionId !== sessionId) continue;
    out.push({ requestId: job.requestId, sessionId: job.sessionId, status: job.status, title: job.title, createdAt: job.createdAt });
  }
  return out;
}
