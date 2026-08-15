/**
 * src/runtime/lifecycle.mjs — start / stop / restart / status.
 *
 * The whole point of this module is that a user never has to run `ps` or
 * `kill -9` to recover. Every operation reconciles the recorded state with the
 * live process before it acts, and every failure path leaves the state file
 * consistent with reality rather than with what we hoped happened.
 *
 * Stopping is escalated, never blunt:
 *   1. Verify the PID is alive.
 *   2. Verify it is OURS, by asking it to echo the runtime token on /health.
 *      A recycled PID or an unrelated process fails this and is left alone.
 *   3. SIGTERM, then wait — the server closes sockets, aborts live agent runs
 *      (which is what reaps its bash/MCP children) and removes its state file.
 *   4. Only if it is still there after the grace period, SIGKILL.
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

import * as state from "./state.mjs";
import { identityMatches } from "./identity.mjs";
import { resolvePort } from "./ports.mjs";
import { terminate } from "./procinfo.mjs";
import { runtimeError } from "../exit.mjs";
import { logsDir, ensureDir } from "../paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(__dirname, "..", "server", "main.mjs");

const STOP_GRACE_MS = 8000;
const START_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Plain liveness probe for external services, which have no identity endpoint. */
async function probeUrl(url, { timeoutMs = 1500 } = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
    return res.status < 500;
  } catch {
    return false;
  }
}

export function status(name) {
  const { status: s, record, reclaimed } = state.readLive(name);
  if (s !== "running") {
    return { running: false, reclaimedStale: Boolean(reclaimed), record: null };
  }
  return {
    running: true,
    reclaimedStale: false,
    record,
    url: `http://${record.host}:${record.port}`,
    uptimeMs: Date.now() - new Date(record.startedAt).getTime(),
  };
}

/**
 * Start a managed service.
 *
 * `service` (from src/services.mjs) describes an EXTERNAL process to run —
 * backend1's Fastify app, or Next.js. Without one, the CLI's own built-in
 * server (src/server/main.mjs) is started instead. Both paths share the same
 * reconciliation, health verification, state file and teardown, so there is one
 * set of lifecycle semantics rather than one per server we happen to ship.
 *
 * @param {{name, host, port, workspace, modelRoute, permissionMode, detach, service?}} options
 * @returns {Promise<{started: boolean, alreadyRunning: boolean, record: object, url: string, child?: ChildProcess}>}
 */
export async function start(options) {
  const {
    name = "ui",
    host = "127.0.0.1",
    port = 4173,
    workspace,
    modelRoute,
    permissionMode = "auto",
    detach = false,
    service: serviceOption = null,
  } = options;

  // 1. Already running? Never start a second one.
  const existing = status(name);
  if (existing.running) {
    return { started: false, alreadyRunning: true, record: existing.record, url: existing.url };
  }

  // 2. Pick a port.
  const chosen = await resolvePort(port, host);
  if (chosen.chosen === "requested" && chosen.free === false) {
    throw runtimeError(
      `Port ${port} on ${host} is already in use by another process.`,
      `Use \`kodo ${name} start --port 0\` to pick a free port automatically, or free the port and retry.`,
    );
  }

  const token = crypto.randomBytes(32).toString("hex");

  // Build the descriptor only AFTER the port is resolved. `--port 0` means "any
  // free port", and resolvePort turns that into a concrete number — a
  // descriptor built beforehand would carry the literal 0 into the child's
  // PORT/--port, so the service would bind a DIFFERENT random port from the one
  // the CLI reserved, verified and reported.
  const service = typeof serviceOption === "function"
    ? serviceOption({ host, port: chosen.port })
    : serviceOption;

  const env = {
    ...process.env,
    KODO_SERVE_NAME: name,
    KODO_SERVE_HOST: host,
    KODO_SERVE_PORT: String(chosen.port),
    KODO_SERVE_TOKEN: token,
    KODO_SERVE_WORKSPACE: workspace,
    KODO_SERVE_PERMISSION: permissionMode,
    KODO_SERVE_MODEL_ROUTE: JSON.stringify(modelRoute || {}),
    ...(service?.env || {}),
  };

  ensureDir(logsDir());
  const logPath = path.join(logsDir(), `${name}.log`);

  // 3. Start it. Detached servers get their own process group so closing the
  //    launching terminal (SIGHUP to the group) does not take them with it.
  //
  // A DETACHED child's output goes straight to the log file, never to a pipe.
  // Piping it would mean the parent has to keep reading forever (holding the
  // terminal) or close the pipe (killing the server with EPIPE the first time
  // it logs). A file descriptor outlives the parent and has neither problem.
  //
  // The parent therefore learns the assigned port from the runtime STATE FILE,
  // which the server writes only after it is genuinely listening — a more
  // trustworthy signal than a line on stdout anyway.
  const logFd = detach ? fs.openSync(logPath, "a", 0o600) : null;
  const child = spawn(
    service ? service.command : process.execPath,
    service ? service.args : [SERVER_ENTRY],
    {
      env,
      cwd: service?.cwd,
      detached: detach,
      stdio: detach ? ["ignore", logFd, logFd] : ["ignore", "pipe", "inherit"],
    },
  );
  if (logFd !== null) fs.closeSync(logFd);   // the child owns it now

  let stderrTail = "";
  if (!detach) {
    // Attached: surface the server's own output on OUR stderr so the terminal
    // shows what it is doing, without ever writing to stdout.
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stderrTail = `${stderrTail}${text}`.slice(-2000);
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try { if (JSON.parse(line).ready) continue; } catch { /* not the handshake line */ }
        process.stderr.write(`${line}\n`);
      }
    });
  }

  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));

  // 4. Verify health before claiming success. "The process started" is not the
  //    same as "the server works", and printing a URL that 500s is worse than
  //    printing an error.
  const failureDetail = () => stderrTail.trim() || `Check ${logPath}.`;

  const deadline = Date.now() + START_TIMEOUT_MS;
  let health = null;
  while (Date.now() < deadline) {
    const exitCode = await Promise.race([exited, sleep(150).then(() => undefined)]);
    if (exitCode !== undefined) {
      throw runtimeError(`The Kodo ${name} server exited immediately (code ${exitCode}).`, failureDetail());
    }
    if (service) {
      // An EXTERNAL service (backend1, Next.js) does not know about Kodo's
      // runtime token, so it cannot echo an identity hash. Liveness on its own
      // health path is the strongest signal available — and the port was
      // reserved by resolvePort before the spawn, so the risk of mistaking a
      // squatter for our service is already bounded.
      const ok = await probeUrl(`http://${host}:${chosen.port}${service.healthPath || "/"}`);
      if (ok) {
        health = { external: true };
        // Write the record ourselves: only the CLI's own server writes its own.
        state.write(name, {
          pid: child.pid,
          port: chosen.port,
          host,
          token,
          external: true,
          service: service.label,
          // How stop() proves this PID is still OUR process rather than a
          // recycled one. The entry script path is distinctive enough to
          // identify, and stable across restarts.
          commandMarker: service.commandMarker || service.args[0],
          version: null,
          workspace,
          startedAt: new Date().toISOString(),
          logFile: logPath,
        });
        break;
      }
      health = null;
      continue;
    }
    // The state file carries the port the server actually bound, which is the
    // only way to learn it when --port 0 was requested.
    const recorded = state.read(name).record;
    health = await state.probeHealth(host, recorded?.port || chosen.port, { timeoutMs: 800 });
    // Identity, not just liveness: something else could already be listening on
    // this port, and reporting its URL as "Kodo started" would be a lie.
    if (identityMatches(token, health?.identity)) break;
    health = null;
  }

  if (!health) {
    try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ }
    state.clear(name);
    throw runtimeError(
      `The Kodo ${name} server did not become healthy within ${START_TIMEOUT_MS / 1000}s.`,
      failureDetail(),
    );
  }

  const { record } = state.read(name);
  // unref() so the parent's event loop is not held open by the child handle —
  // `kodo ui start --detach` must return the shell rather than waiting on a
  // server that is meant to outlive it.
  if (detach) child.unref();

  return {
    started: true,
    alreadyRunning: false,
    record,
    url: `http://${record.host}:${record.port}`,
    token,
    child: detach ? null : child,
  };
}

/**
 * @returns {Promise<{stopped: boolean, wasRunning: boolean, escalated: boolean, reason?: string}>}
 */
export async function stop(name, { graceMs = STOP_GRACE_MS } = {}) {
  const { status: s, record } = state.read(name);

  if (s === "stopped") return { stopped: false, wasRunning: false, escalated: false };
  if (s === "stale") {
    state.clear(name);
    return { stopped: false, wasRunning: false, escalated: false, reason: "stale_state_cleared" };
  }

  // Identity check. Without this, a PID recycled by the OS since the file was
  // written would be signalled — that is how a lifecycle manager kills an
  // unrelated process belonging to the user.
  //
  // On Windows this THROWS rather than returning false, because "cannot verify"
  // and "verified as not ours" warrant completely different messages.
  let isOurs;
  try {
    isOurs = await state.verifyIdentity(record);
  } catch (err) {
    throw runtimeError(err.message);
  }
  if (!isOurs) {
    state.clear(name);
    return {
      stopped: false,
      wasRunning: false,
      escalated: false,
      reason: "identity_mismatch",
    };
  }

  // terminate() rather than process.kill(): Windows has no signals, and
  // process.kill(pid,"SIGTERM") there kills that one process ungracefully,
  // orphaning whatever it spawned. procinfo routes to taskkill /T on Windows
  // and a real SIGTERM on POSIX.
  if (!terminate(record.pid)) {
    throw runtimeError(`Could not signal PID ${record.pid}.`);
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!state.pidAlive(record.pid)) {
      state.clear(name);
      return { stopped: true, wasRunning: true, escalated: false };
    }
    await sleep(120);
  }

  // Escalate only now, and only to a PID we have positively identified.
  terminate(record.pid, { force: true });
  await sleep(300);
  state.clear(name);
  return { stopped: !state.pidAlive(record.pid), wasRunning: true, escalated: true };
}

export async function restart(options) {
  const stopped = await stop(options.name);
  // A port takes a moment to be released after the process exits; starting
  // instantly can lose the race and report a spurious "port in use".
  if (stopped.wasRunning) await sleep(400);
  const started = await start(options);
  return { ...started, restarted: stopped.wasRunning };
}
