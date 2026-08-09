/**
 * bench/limits.mjs
 * The execution budget every agent runs under, whoever it is.
 *
 * Kodo self-limits: MAX_ITERATIONS, a context budget, its own controller stop
 * rules. An external CLI has none of that — left alone it would run until the
 * benchmark's timeout, and a comparison between "an agent capped at 32 turns"
 * and "an agent capped at nothing" measures the caps, not the agents.
 *
 * So the FRAMEWORK imposes one budget on everyone. Deliberately expressed in
 * agent-neutral units — seconds, bytes, processes — because iterations and
 * tokens are not comparable across agents and must never become a limit that
 * binds one agent and not another.
 *
 * Nothing here ranks anything. A run that hits a limit is recorded as having
 * hit it; how that is scored is the runner's business.
 */

/** Bytes of stdout/stderr kept from a subprocess before truncation. */
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
/** Bytes an agent may add to the workspace. Guards against a runaway writer. */
const MAX_WORKSPACE_GROWTH_BYTES = 64 * 1024 * 1024;
/** Grace between SIGTERM and SIGKILL, so a process can flush and exit cleanly. */
const TERMINATION_GRACE_MS = 5_000;

export const DEFAULT_LIMITS = Object.freeze({
  /** Hard ceiling on one benchmark, whoever runs it. Overridable per benchmark. */
  maxWallClockMs: 600_000,
  maxStdoutBytes: MAX_STDOUT_BYTES,
  maxWorkspaceGrowthBytes: MAX_WORKSPACE_GROWTH_BYTES,
  terminationGraceMs: TERMINATION_GRACE_MS,
});

/**
 * The budget for one benchmark. A benchmark may ask for LESS time than the
 * default but never more: a task that quietly grants itself an hour is not
 * being compared on the same terms as one capped at ten minutes.
 */
export function limitsFor(benchmark, overrides = {}) {
  const wanted = benchmark?.metadata?.timeoutMs ?? DEFAULT_LIMITS.maxWallClockMs;
  return {
    ...DEFAULT_LIMITS,
    ...overrides,
    maxWallClockMs: Math.min(wanted, overrides.maxWallClockMs ?? DEFAULT_LIMITS.maxWallClockMs),
  };
}

/**
 * Accumulate output up to a cap.
 *
 * Truncation is recorded, not silent: a run whose output was cut off is a
 * different observation from one that simply said little, and a reader must be
 * able to tell them apart.
 */
export function createOutputSink(maxBytes) {
  let bytes = 0;
  let truncated = false;
  const chunks = [];
  return {
    write(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (bytes >= maxBytes) { truncated = true; return; }
      const room = maxBytes - bytes;
      if (buf.length > room) {
        chunks.push(buf.subarray(0, room));
        bytes = maxBytes;
        truncated = true;
      } else {
        chunks.push(buf);
        bytes += buf.length;
      }
    },
    get truncated() { return truncated; },
    get bytes() { return bytes; },
    toString() {
      const s = Buffer.concat(chunks).toString("utf-8");
      return truncated ? `${s}\n…[output truncated at ${maxBytes} bytes]` : s;
    },
  };
}

/**
 * Stop a child process the way a well-behaved supervisor does: ask, wait, then
 * insist. SIGKILL alone loses whatever the agent was midway through writing,
 * which turns a timeout into a corrupted workspace and a misleading result.
 *
 * @returns {Promise<"exited"|"terminated"|"killed">}
 */
export function terminateGracefully(child, graceMs = TERMINATION_GRACE_MS) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve("exited");
    let settled = false;
    const done = (how) => { if (!settled) { settled = true; clearTimeout(timer); resolve(how); } };

    child.once("exit", () => done("terminated"));
    try { child.kill("SIGTERM"); } catch { return done("exited"); }

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      done("killed");
    }, graceMs);
  });
}

/**
 * Signatures meaning "this agent is not usable right now" rather than "this
 * agent failed the task".
 *
 * This distinction is the whole credibility of a cross-agent report. An
 * unauthenticated CLI exits non-zero and leaves the workspace untouched, which
 * is indistinguishable from a total failure — and both `claude` and `codex`
 * really do this, one printing to stdout and one to stderr. Scoring that as
 * `fail` would publish "Claude Code failed 22/22 benchmarks" when the true
 * statement is "Claude Code was never logged in".
 */
const NOT_READY_RE =
  /\bnot logged ?in\b|\bplease run \/login\b|\brun `?\/login\b|\bnot authenticated\b|\bauthentication (?:failed|required)\b|\bunauthorized\b|\b401\b|\binvalid api key\b|\bmissing api key\b|\bno api key\b|\bcredit balance is too low\b|\bquota\b|\brate limit(?:ed)?\b|\b429\b|\brefresh_token_reused\b|\bplease sign in\b|\bsigning in again\b|\blogin required\b/i;

/**
 * Classify a finished CLI invocation.
 * @returns {null | {stage: string, message: string}} a blocker, or null if the
 *          agent really did run and its result should be scored.
 */
export function classifyCliFailure({ name, code, stdout, stderr, timedOut }) {
  if (timedOut) return null; // a timeout is the agent's own problem, and is scored
  if (code === 0) return null;

  const blob = `${stdout ?? ""}\n${stderr ?? ""}`;
  if (NOT_READY_RE.test(blob)) {
    const line = blob.split("\n").map((l) => l.trim()).find((l) => NOT_READY_RE.test(l)) ?? blob.slice(0, 200);
    return {
      stage: "agent_unavailable",
      message:
        `the "${name}" CLI is installed but not usable: ${line.slice(0, 300)}. ` +
        "Reported as blocked, not failed — an agent that never authenticated has not lost at the task. " +
        `Authenticate it (\`${name === "claude-code" ? "claude" : name}\` → /login, or set its API key) and rerun.`,
    };
  }
  // Exited non-zero for some other reason: that is a real run with a real
  // failure, and it gets scored like one.
  return null;
}
