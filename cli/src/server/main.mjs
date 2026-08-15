#!/usr/bin/env node
/**
 * src/server/main.mjs — the Kodo server process.
 *
 * Spawned by `kodo ui start` (detached or attached). It is a separate process
 * on purpose: an agent run can take tens of minutes, and the terminal you
 * launched it from must be free to close without killing it.
 *
 * Configuration arrives via KODO_SERVE_* environment variables rather than
 * argv, so the runtime token never appears in `ps` output.
 *
 * Contract with the lifecycle manager:
 *   - writes the runtime state file only AFTER the socket is actually listening
 *     (so "running" in the state file is never aspirational), and
 *   - removes it on every exit path it can observe.
 */

import { createApp } from "./app.mjs";
import { loadCore } from "../core.mjs";
import * as state from "../runtime/state.mjs";
import { ensureDir, logsDir } from "../paths.mjs";
import { routeConsoleToStderr } from "../term.mjs";
import fs from "fs";
import path from "path";

const NAME        = process.env.KODO_SERVE_NAME || "ui";
const HOST        = process.env.KODO_SERVE_HOST || "127.0.0.1";
const PORT        = Number(process.env.KODO_SERVE_PORT || 0);
const TOKEN       = process.env.KODO_SERVE_TOKEN || "";
const WORKSPACE   = process.env.KODO_SERVE_WORKSPACE || process.cwd();
const PERMISSION  = process.env.KODO_SERVE_PERMISSION || "auto";
const MODEL_ROUTE = JSON.parse(process.env.KODO_SERVE_MODEL_ROUTE || "{}");

const logFile = path.join(ensureDir(logsDir()), `${NAME}.log`);

/**
 * Structured, rotating log. Never records the token, the API key, or file
 * contents — see docs/security.md. Rotation is size-based and keeps one
 * previous file, which is enough to debug a crash without unbounded growth.
 */
function logLine(level, message) {
  const line = `${JSON.stringify({ ts: new Date().toISOString(), level, name: NAME, pid: process.pid, message })}\n`;
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) {
      fs.renameSync(logFile, `${logFile}.1`);
    }
    fs.appendFileSync(logFile, line, { mode: 0o600 });
  } catch { /* logging must never take the server down */ }
  if (level === "error") process.stderr.write(line);
}

// A closed stdout/stderr must never kill the server. If the launching terminal
// goes away, or a parent stops reading the pipe, writing a log line raises
// EPIPE — and an unhandled EPIPE would take down a server that is in the middle
// of an agent run, losing the run and orphaning its child processes. Logging is
// the least important thing this process does; it does not get a veto.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err) => {
    if (err.code !== "EPIPE") throw err;
  });
}

async function main() {
  if (!TOKEN) {
    process.stderr.write("kodo server: refusing to start without a runtime token\n");
    process.exit(6);
  }

  // The parent parses this process's stdout to learn which port it bound, so
  // stray console.log from the agent must not land there.
  routeConsoleToStderr();

  const core = await loadCore();

  const server = createApp({
    core,
    token: TOKEN,
    version: core.VERSION,
    workspace: WORKSPACE,
    modelRoute: MODEL_ROUTE,
    permissionMode: PERMISSION,
    log: (m) => logLine("warn", m),
  });

  server.on("error", (err) => {
    logLine("error", `listen failed: ${err.message}`);
    process.stderr.write(`kodo server: ${err.message}\n`);
    process.exit(6);
  });

  await new Promise((resolve) => server.listen(PORT, HOST, resolve));
  const actualPort = server.address().port;

  state.write(NAME, {
    pid: process.pid,
    port: actualPort,
    host: HOST,
    token: TOKEN,
    version: core.VERSION,
    workspace: WORKSPACE,
    permissionMode: PERMISSION,
    startedAt: new Date().toISOString(),
    logFile,
  });

  logLine("info", `listening on http://${HOST}:${actualPort}`);
  // The parent reads this line to learn the port when it asked for port 0.
  process.stdout.write(`${JSON.stringify({ ready: true, host: HOST, port: actualPort, pid: process.pid })}\n`);

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;          // a second Ctrl+C must not re-enter
    closing = true;
    logLine("info", `${signal} — shutting down`);
    // Bound it: a wedged MCP server or child process must not make Ctrl+C hang.
    const timeout = setTimeout(() => { logLine("warn", "shutdown timed out"); process.exit(0); }, 10_000);
    timeout.unref();
    try { await server.shutdown(); } catch (err) { logLine("warn", `shutdown error: ${err.message}`); }
    state.clear(NAME);
    process.exit(0);
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => void shutdown(signal));
  }
  // A crash still has to clear the state file, or the next `ui start` reports a
  // server that is not there. (readLive() reclaims it too — belt and braces.)
  process.on("uncaughtException", (err) => {
    logLine("error", `uncaught: ${err.stack || err.message}`);
    state.clear(NAME);
    process.exit(6);
  });
}

main().catch((err) => {
  logLine("error", `startup failed: ${err.stack || err.message}`);
  process.stderr.write(`kodo server: ${err.message}\n`);
  state.clear(NAME);
  process.exit(6);
});
