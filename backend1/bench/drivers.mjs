/**
 * bench/drivers.mjs
 * How a benchmark actually starts Kodo against a workspace.
 *
 * A driver is `async ({benchmark, workspace, prompt, recorder, signal}) =>
 * {finalAnswer, editedFiles, usage, runMetrics}`. Factoring it out this way is
 * what lets the framework's own tests exercise the full runner — workspace
 * isolation, transcript capture, validation, scoring, artifacts — end to end
 * against a scripted driver, with no API key and no billed calls, while the
 * real suite runs the identical code path against the real agent.
 *
 * `preflight()` is how a driver reports it cannot run at all. That answer
 * becomes a `blocked` result with the real reason attached, never a failure.
 */

/**
 * The real thing: router → answer/agent_loop, real model, real tools, against
 * the isolated benchmark workspace.
 */
/**
 * The credentials a benchmark run uses, read from the environment only.
 *
 * Passed to the graph as an explicit `modelRoute`, which is the highest
 * precedence branch in resolveCreds. That matters: the fallback path underneath
 * it reads `backend1/data/settings.json` — the app's own saved settings —
 * before it ever looks at env vars. A benchmark that inherited those would be
 * credentialed by whatever the UI was last configured with, while the run
 * report recorded whatever DEFAULT_MODEL happened to say. Two runs could then
 * differ in the one variable a comparison exists to hold constant, and the
 * artifact would not show it. So the runner states its credentials outright.
 */
export function benchCreds() {
  return {
    ok: true,
    apiKey: process.env.OPENAI_API_KEY || "",
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    model: process.env.DEFAULT_MODEL || "",
  };
}

export const kodoDriver = {
  name: "kodo",

  /**
   * What this driver will run against, minus the secret. The runner records it
   * in the report so a comparison can tell "Kodo got worse" apart from "the
   * model changed underneath us".
   */
  creds() {
    const { model, baseUrl } = benchCreds();
    return { model, baseUrl };
  },

  /** @returns {null | {stage: string, message: string}} */
  preflight() {
    const { apiKey, model } = benchCreds();
    const missing = [!apiKey && "OPENAI_API_KEY", !model && "DEFAULT_MODEL"].filter(Boolean);
    if (missing.length) {
      return {
        stage: "preflight",
        message:
          `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set. The benchmark runner drives the ` +
          "real agent loop and makes real, billed model calls. It deliberately does NOT fall back to the app's " +
          "saved settings (backend1/data/settings.json) — a run has to say which model it measured, or its results " +
          "cannot be compared to anything. Set OPENAI_API_KEY, DEFAULT_MODEL and OPENAI_BASE_URL (in backend1/.env " +
          "or the environment) and rerun.",
      };
    }
    return null;
  },

  async run({ benchmark, workspace, prompt, recorder, signal }) {
    // Imported here, not at module load: the agent's config layer constructs a
    // provider client on import and throws without credentials. Listing,
    // reporting, comparing and replaying must all work with no API key at all.
    const { runKodoGraph } = await import("../services/graph_runner.mjs");

    const result = await runKodoGraph({
      userMessage: prompt,
      sessionId: `bench_${benchmark.id}`,
      requestId: `bench_${benchmark.id}_${Date.now()}`,
      userId: "bench",
      workspacePath: workspace,
      // Explicit, from the environment — see benchCreds() above for why this is
      // not left to resolveCreds' fallback chain.
      modelRoute: benchCreds(),
      emit: recorder.emit,
      // Benchmark transcripts go to the recorder, NOT to turn_events. Nothing
      // a benchmark does enters the agent's live session memory.
      recordEvent: recorder.recordEvent,
      askUser: recorder.askUser,
      permissionMode: benchmark.metadata.permissionMode,
      abortSignal: signal,
    });

    return {
      finalAnswer: result?.finalAnswer ?? "",
      editedFiles: Array.isArray(result?.editedFiles) ? result.editedFiles : [],
      usage: result?.usage ?? null,
      runMetrics: result?.runMetrics ?? null,
    };
  },
};

/**
 * A driver built from a plain function. Used by the framework's own tests to
 * script agent behaviour (including misbehaviour: claiming success without
 * doing the work, stopping early, hitting a blocker) so scoring can be proven
 * against known-bad runs, not just hoped-for good ones.
 */
export function scriptedDriver(fn, { name = "scripted", preflight = () => null } = {}) {
  return { name, preflight, run: fn };
}

// ── The driver contract ─────────────────────────────────────────────────────
/**
 * Every agent — Kodo, Claude Code, Codex, a scripted stub — is measured through
 * this one interface, and nothing downstream of it knows which agent ran:
 *
 *   name                 stable identifier, recorded in the report
 *   run({...}) → result  drive the agent against `workspace` with `prompt`
 *   preflight()          optional; return a blocker if it cannot run at all
 *   creds()              optional; {model, baseUrl} recorded for comparability
 *   reportsEditedFiles   optional; false when the agent cannot self-report
 *                        which files it touched (see below)
 *
 * The run result is `{finalAnswer, editedFiles, usage, runMetrics}`, and every
 * field except `finalAnswer` may be empty or null. That is deliberate: an
 * external CLI agent cannot tell us its iteration count or token usage, and
 * inventing zeros for it would make it look free next to Kodo. Missing is
 * reported as missing.
 *
 * What must NOT vary by driver: the corpus, the fixture workspace, the
 * validators, and the scoring rules. Those all live downstream in
 * runBenchmark/scoreRun and are reached identically whichever driver ran — that
 * is what makes a cross-agent number mean anything.
 */
export function defineDriver(driver) {
  if (!driver || typeof driver !== "object") throw new Error("a driver must be an object");
  if (typeof driver.name !== "string" || !driver.name.trim()) throw new Error("a driver needs a name");
  if (typeof driver.run !== "function") throw new Error(`driver "${driver.name}" has no run() function`);
  for (const optional of ["preflight", "creds"]) {
    if (driver[optional] !== undefined && typeof driver[optional] !== "function") {
      throw new Error(`driver "${driver.name}".${optional} must be a function if present`);
    }
  }
  return driver;
}

// ── External CLI agents ─────────────────────────────────────────────────────

import { limitsFor, createOutputSink, terminateGracefully, classifyCliFailure } from "./limits.mjs";

/**
 * Adapter for any headless coding agent that runs as a CLI in a directory —
 * Claude Code (`claude -p`), Codex, or an in-house tool.
 *
 * Deliberately generic rather than one bespoke driver per vendor: the only
 * things that actually differ are the binary name, the argv shape, and how the
 * prompt is delivered. Everything else — isolated workspace, transcript
 * capture, measuring changed files from disk, validation, scoring — is already
 * agent-agnostic and must stay that way for the comparison to be fair.
 *
 * @param {object} cfg
 * @param {string} cfg.name          driver id, e.g. "claude-code"
 * @param {string} cfg.command       binary to execute
 * @param {(prompt: string) => string[]} cfg.args  argv builder
 * @param {boolean} [cfg.promptOnStdin]  deliver the prompt on stdin instead of argv
 * @param {string}  [cfg.installHint]    shown when the binary is missing
 * @param {Record<string,string>} [cfg.env]  extra environment
 */
/**
 * Run a short command and capture its outcome. Injectable so preflight can be
 * tested against every failure shape without installing an agent.
 */
async function defaultExecProbe(command, argv, { timeoutMs = 60_000, cwd, env } = {}) {
  const { spawn } = await import("child_process");
  const os = await import("os");
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, argv, {
        cwd: cwd ?? os.tmpdir(),
        env: { ...process.env, ...env, NO_COLOR: "1", CI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      return resolve({ spawned: false, code: -1, stdout: "", stderr: String(e?.message ?? e), timedOut: false });
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ spawned: false, code: -1, stdout, stderr: `${stderr}${e.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ spawned: true, code, stdout, stderr, timedOut });
    });
  });
}

export function externalCliDriver(cfg) {
  const {
    name, command, args, promptOnStdin = false, installHint = "", env = {},
    timeoutMs,
    // How to prove the agent is USABLE, not merely installed.
    authProbeArgs = (p) => ["-p", p],
    authProbeTimeoutMs = 90_000,
    execProbe = defaultExecProbe,
  } = cfg;

  /**
   * Probed once per process. The probe is a real round-trip to the agent's
   * provider, so it costs a token or two when the agent IS authenticated;
   * repeating it per benchmark would multiply that by the size of the suite for
   * no extra information.
   */
  let cachedPreflight;

  const blocked = (reason, message) => ({
    // `status`/`reason` are the structured form; `stage`/`message` are what the
    // runner and every report already read. Both, so nothing downstream changes.
    status: "blocked",
    reason,
    stage: "preflight",
    message,
  });

  return defineDriver({
    name,
    // An external CLI reports no per-file accounting, so the runner must not
    // compare its (empty) self-report against the disk and call the mismatch
    // dishonesty. Changed files are still measured from the workspace.
    reportsEditedFiles: false,

    creds() {
      return { model: process.env[`${name.toUpperCase().replace(/-/g, "_")}_MODEL`] || null, baseUrl: null };
    },

    /**
     * "Installed" and "usable" are different questions, and only the second one
     * makes a comparison possible.
     *
     * Checking PATH alone reported `claude-code ✅ ready` for a CLI that answers
     * every prompt with "Not logged in", and `codex ✅ ready` for one holding a
     * stale refresh token. Both would have produced a full suite of blocked
     * runs after the operator had already committed to the comparison. So
     * preflight now actually talks to the agent once and requires a real answer.
     */
    async preflight() {
      if (cachedPreflight !== undefined) return cachedPreflight;

      const onPath = await execProbe("command", ["-v", command], { timeoutMs: 5_000 });
      if (!onPath.spawned || onPath.code !== 0) {
        return (cachedPreflight = blocked("not_installed",
          `the "${name}" driver needs the \`${command}\` executable on PATH, and it was not found. ` +
          (installHint ? `${installHint} ` : "") +
          "Reported as blocked rather than scored — an uninstalled agent has not lost at the tasks."));
      }

      const probe = await execProbe(command, authProbeArgs("Reply only: OK"), { timeoutMs: authProbeTimeoutMs, env });

      if (probe.timedOut) {
        return (cachedPreflight = blocked("timeout",
          `the "${name}" CLI did not answer a one-word prompt within ${authProbeTimeoutMs}ms. ` +
          "It is installed, but something between it and its provider is not responding — benchmarking it now " +
          "would measure that, not the agent."));
      }

      const blob = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;

      // Auth/credential problems, whatever the exit code: `claude` prints
      // "Not logged in" to STDOUT and `codex` prints a 401 to STDERR.
      const authBlocker = classifyCliFailure({ name, code: probe.code === 0 ? 1 : probe.code, stdout: probe.stdout, stderr: probe.stderr, timedOut: false });
      if (probe.code !== 0 && authBlocker) {
        return (cachedPreflight = blocked("authentication",
          `${name} requires login — ${authBlocker.message}`));
      }

      if (probe.code !== 0) {
        return (cachedPreflight = blocked("probe_failed",
          `the "${name}" CLI exited ${probe.code} on a one-word prompt: ${blob.trim().slice(0, 300) || "(no output)"}. ` +
          "It cannot be benchmarked until it can answer at all."));
      }

      // Exit 0 but nothing usable back: a CLI that prints a banner and quits is
      // not answering, and would score every benchmark as a silent failure.
      if (!String(probe.stdout ?? "").trim()) {
        return (cachedPreflight = blocked("malformed_output",
          `the "${name}" CLI exited 0 but produced no output for a one-word prompt. ` +
          `stderr: ${String(probe.stderr ?? "").trim().slice(0, 200) || "(empty)"}`));
      }

      return (cachedPreflight = null);
    },

    async run({ benchmark, workspace, prompt, recorder, signal }) {
      const { spawn } = await import("child_process");
      const argv = args(prompt);
      // The same budget Kodo runs under. See bench/limits.mjs for why this is
      // expressed in seconds and bytes rather than iterations.
      const limits = limitsFor(benchmark, { maxWallClockMs: timeoutMs });

      recorder.recordEvent({
        kind: "tool", toolName: `${name}:invoke`, toolArgs: { command, args: argv },
        content: JSON.stringify({ started: true, limits }), status: "ok", durationMs: 0,
      });
      recorder.emit({ type: "progress", stage: "executing", message: `\u25b6 ${command} ${argv.join(" ")}` });

      const startedAt = Date.now();
      const out = createOutputSink(limits.maxStdoutBytes);
      const err = createOutputSink(limits.maxStdoutBytes);

      const { code, timedOut, termination } = await new Promise((resolve) => {
        const child = spawn(command, argv, {
          cwd: workspace,
          env: { ...process.env, ...env, NO_COLOR: "1", CI: "1" },
          stdio: [promptOnStdin ? "pipe" : "ignore", "pipe", "pipe"],
        });
        let killed = false;
        let how = null;
        const stop = async () => { killed = true; how = await terminateGracefully(child, limits.terminationGraceMs); };
        const timer = setTimeout(stop, limits.maxWallClockMs);
        const onAbort = () => { stop(); };
        signal?.addEventListener?.("abort", onAbort, { once: true });

        child.stdout?.on("data", (d) => out.write(d));
        child.stderr?.on("data", (d) => err.write(d));
        if (promptOnStdin) { child.stdin.write(prompt); child.stdin.end(); }

        const finish = (c) => {
          clearTimeout(timer);
          signal?.removeEventListener?.("abort", onAbort);
          resolve({ code: c, timedOut: killed, termination: how });
        };
        child.on("error", (e) => { err.write(`\n${e.message}`); finish(-1); });
        child.on("close", (c) => finish(c));
      });

      const durationMs = Date.now() - startedAt;
      const stdout = out.toString();
      const stderr = err.toString();

      recorder.recordEvent({
        kind: "tool", toolName: `${name}:exit`, toolArgs: { code, timedOut, termination },
        content: JSON.stringify({ code, timedOut, termination, truncated: out.truncated, stderr: stderr.slice(0, 4000) }),
        status: code === 0 ? "ok" : "error", durationMs,
      });

      // An installed-but-unauthenticated agent must not be scored as failing
      // the task. See classifyCliFailure().
      const blocker = classifyCliFailure({ name, code, stdout, stderr, timedOut });
      if (blocker) return { blocker, finalAnswer: stdout || stderr, editedFiles: [], usage: null, runMetrics: null };

      const finalAnswer = stdout.trim() || stderr.trim();
      recorder.emit({ type: "content", content: finalAnswer });

      return {
        finalAnswer,
        editedFiles: [],
        usage: null,
        runMetrics: {
          exitReason: timedOut ? "cancelled" : code === 0 ? "completed" : "cli_error",
          iterations: null, stoppedEarly: false, durationMs,
          model: null, providerError: null, controller: null,
          limitHit: timedOut ? "wall_clock" : out.truncated ? "stdout_bytes" : null,
          termination,
        },
      };
    },
  });
}

/**
 * Claude Code, headless. Placeholder in the sense that this repo does not ship
 * the binary — but the adapter is real: install Claude Code, put `claude` on
 * PATH, and `--driver claude-code` runs the identical corpus.
 */
export const claudeCodeDriver = externalCliDriver({
  name: "claude-code",
  command: "claude",
  // -p is headless "print" mode: run the prompt to completion, print the result.
  args: (prompt) => ["-p", prompt, "--permission-mode", "acceptEdits"],
  authProbeArgs: (prompt) => ["-p", prompt],
  installHint: "Install with `npm i -g @anthropic-ai/claude-code`, then run `claude` and `/login`.",
});

/**
 * OpenAI Codex CLI, non-interactive. Same story: adapter is real, binary is not
 * vendored here.
 */
export const codexDriver = externalCliDriver({
  name: "codex",
  command: "codex",
  args: (prompt) => ["exec", "--skip-git-repo-check", prompt],
  authProbeArgs: (prompt) => ["exec", "--skip-git-repo-check", prompt],
  installHint: "Install with `npm i -g @openai/codex`, then run `codex login`.",
});

// ── Status rendering ────────────────────────────────────────────────────────

/**
 * Render one line per driver, blocked ones included.
 *
 * Lives here rather than in cli.mjs so it can be tested without executing the
 * CLI (which runs `main()` on import) and without probing a real agent.
 *
 * The indentation matters more than it looks. A blocker message can carry raw
 * newlines — `codex` reports a multi-line stack of ERROR lines — and printing
 * it unmodified pushes continuation lines to column 0, which visually shatters
 * the per-driver blocks and reads as if the listing had collapsed to whichever
 * driver happened to print last. Every driver must remain a clean, separate,
 * indented block no matter what its agent wrote to stderr.
 *
 * @param {{name: string, blocker: object|null}[]} statuses
 */
export function formatDriverStatusReport(statuses) {
  const L = [];
  L.push("");
  L.push("Agent drivers for `bench run --driver <name>`");
  L.push("(ready = executable AND authenticated, not merely installed)");
  L.push("");

  for (const { name, blocker } of statuses) {
    L.push(`  ${name}:`);
    if (!blocker) {
      L.push("    ✅ authenticated");
      continue;
    }
    const reason = blocker.reason ?? blocker.stage ?? "blocked";
    L.push(`    🚧 blocked: ${reason === "authentication" ? "authentication required" : reason}`);
    // Flatten and re-indent: one driver, one block, whatever the agent printed.
    const detail = String(blocker.message ?? "")
      .replace(/\s*\n\s*/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 240);
    if (detail) L.push(`       ${detail}`);
  }

  const blockedCount = statuses.filter((s) => s.blocker).length;
  L.push("");
  if (blockedCount) {
    // Named, not just counted: a bare "1 agent(s) blocked" makes the reader
    // scroll back to work out which one.
    const names = statuses.filter((s) => s.blocker).map((s) => s.name).join(", ");
    L.push(`  ${blockedCount} of ${statuses.length} agent(s) blocked: ${names}`);
    L.push("  A comparison including them cannot produce results.");
    L.push("");
  }
  return L.join("\n");
}

// ── Registry ────────────────────────────────────────────────────────────────

const REGISTRY = new Map();

export function registerDriver(driver) {
  const d = defineDriver(driver);
  REGISTRY.set(d.name, d);
  return d;
}

/** @returns {object} the driver, or throws naming what IS available. */
export function getDriver(name) {
  const d = REGISTRY.get(name);
  if (!d) throw new Error(`unknown driver "${name}". Available: ${listDrivers().join(", ")}`);
  return d;
}

export function listDrivers() {
  return [...REGISTRY.keys()].sort();
}

registerDriver(kodoDriver);
registerDriver(claudeCodeDriver);
registerDriver(codexDriver);

/** Back-compat: the object form some callers already use. */
export const DRIVERS = {
  get kodo() { return getDriver("kodo"); },
  get "claude-code"() { return getDriver("claude-code"); },
  get codex() { return getDriver("codex"); },
};
