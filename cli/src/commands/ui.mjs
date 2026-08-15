/**
 * src/commands/ui.mjs — `kodo ui start|stop|restart|status`.
 *
 * Also serves `kodo server`, which is the same lifecycle under a different
 * state key. They are separated because they are genuinely different servers:
 * `ui` is the local single-user runtime this CLI ships, `server` is backend1's
 * multi-user Fastify app that the VS Code extension and the Next.js web app
 * already speak to. Combining them would mean one of those two audiences gets a
 * server that does not do what it expects.
 */

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

import { parseArgs } from "../args.mjs";
import { EXIT, usageError, runtimeError, CliError } from "../exit.mjs";
import { resolveConfig } from "../config.mjs";
import { buildModelRoute, inspectModelRoute } from "../creds.mjs";
import { detectWorkspace, displayPath } from "../workspace.mjs";
import { readApiSessionToken } from "../session.mjs";
import * as lifecycle from "../runtime/lifecycle.mjs";
import { apiService, nextUiService, inspectWebUi, inspectBackend } from "../services.mjs";
import { out, log, style, ok, warn, humanDuration, kv } from "../term.mjs";
import { logsDir } from "../paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SPEC = {
  port:         { type: "number" },
  host:         { type: "string" },
  cwd:          { type: "string" },
  model:        { type: "string" },
  permission:   { type: "string" },
  detach:       { type: "boolean" },
  open:         { type: "boolean" },
  json:         { type: "boolean" },
  "yes-i-know": { type: "boolean" },
  builtin:      { type: "boolean" },
  "api-port":   { type: "number" },
  help:         { type: "boolean", short: "h" },
  color:        { type: "boolean", default: true },
  verbose:      { type: "boolean" },
  debug:        { type: "boolean" },
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export async function uiCommand({ argv, name = "ui" }) {
  const { flags, positional } = parseArgs(argv, SPEC);
  const action = positional[0] || "start";

  switch (action) {
    case "start":   return startAction(flags, name);
    case "stop":    return stopAction(flags, name);
    case "restart": return restartAction(flags, name);
    case "status":  return statusAction(flags, name);
    case "logs":    return logsAction(flags, name);
    default:
      throw usageError(
        `Unknown ${name} action "${action}".`,
        "Valid actions: start, stop, restart, status, logs",
      );
  }
}

/**
 * Bring the Local API up if it is not already, and return its record.
 *
 * Reuses a running one rather than starting a second: the API owns live agent
 * sessions and background jobs, so restarting it under a UI launch would kill
 * work the user may still be watching.
 */
async function ensureApi({ flags, config, sources, workspace, modelRoute }) {
  const existing = lifecycle.status("server");
  if (existing.running) {
    // A running API is bound to the workspace it was STARTED with — that is
    // baked into its process environment and cannot be retargeted from here.
    // Reusing it for a different project would silently operate on the wrong
    // one: you would `cd ~/projects/b`, run `kodo ui start`, get a working UI,
    // and the agent would read and WRITE files in ~/projects/a.
    //
    // Refusing is the honest answer. Kodo does not guess which project you
    // meant, and it does not quietly retarget a server other work may be
    // running against.
    const boundTo = existing.record?.workspace;
    if (boundTo && path.resolve(boundTo) !== path.resolve(workspace.path)) {
      throw runtimeError(
        `The Kodo API is already running for a different project: ${displayPath(boundTo)}.`,
        `To use ${displayPath(workspace.path)} instead, stop it first: kodo ui stop && kodo server stop`,
      );
    }
    log(style.dim(`  using the Kodo API already running on ${existing.url}`));
    return existing.record;
  }

  const backend = inspectBackend();
  if (!backend.available) {
    throw runtimeError(
      `The Kodo API cannot start: ${backend.reason}.`,
      backend.fix || "Reinstall Kodo, or run `kodo doctor`.",
    );
  }

  // An EXPLICIT port is honoured strictly — if it is taken, that is an error,
  // because the caller asked for that port specifically. A DEFAULT is not a
  // request: 9000 is routinely occupied (often by a `npm run backend` the user
  // started themselves), and failing `kodo ui start` over a port nobody chose
  // is a bad trade when any free port works just as well.
  // `sources` distinguishes a value the USER set from the built-in default.
  // Without it, DEFAULTS.server.port (9000) reads as an explicit choice and the
  // fallback below never fires.
  const userChosePort = sources?.server && sources.server !== "defaults";
  const explicitPort = flags["api-port"] !== undefined
    ? flags["api-port"]
    : (userChosePort ? config.server?.port : null);
  const apiPort = explicitPort ?? 9000;

  log(style.dim("  starting the Kodo API…"));
  const launch = (port) => lifecycle.start({
    name: "server",
    host: "127.0.0.1",
    port,
    workspace: workspace.path,
    modelRoute,
    permissionMode: config.permission || "auto",
    // Always detached: the API must outlive a UI restart.
    detach: true,
    service: (resolved) => apiService({ ...resolved, workspace: workspace.path }),
  });

  let started;
  try {
    started = await launch(apiPort);
  } catch (err) {
    if (explicitPort !== null || !/already in use/i.test(err.message)) throw err;
    log(style.dim(`  port ${apiPort} is busy — using a free port instead`));
    started = await launch(0);
  }
  log(style.dim(`  API ready on ${started.url}`));
  return started.record;
}

/**
 * The real Next.js application when it is available, the CLI's built-in page
 * otherwise. Falling back is stated out loud rather than done silently — the
 * two are not equivalent, and a user who expected the full UI should be told
 * which one they got and how to get the other.
 */
function resolveUiService({ flags, apiRecord }) {
  const apiOrigin = apiRecord ? `http://${apiRecord.host}:${apiRecord.port}` : "http://127.0.0.1:9000";

  if (flags.builtin) return null;   // null → lifecycle starts the built-in server

  const webUi = inspectWebUi();
  if (!webUi.available) {
    warn(`the full Kodo UI is unavailable — ${webUi.reason}.`);
    if (webUi.fix) log(style.dim(`  To use it: ${webUi.fix}`));
    log(style.dim("  Falling back to the built-in single-page UI."));
    return null;
  }

  return (resolved) => nextUiService({ ...resolved, apiOrigin });
}

function resolveBind(flags, config, name) {
  const defaults = config[name] || {};
  const host = flags.host || defaults.host || "127.0.0.1";
  const port = flags.port !== undefined ? flags.port : (defaults.port ?? (name === "ui" ? 4173 : 9000));

  if (!LOOPBACK.has(host)) {
    if (!flags["yes-i-know"]) {
      throw new CliError(
        `Refusing to bind Kodo to ${host}.`,
        EXIT.PERMISSION,
        {
          hint:
            "Kodo can read and write files and run shell commands in your project. Binding it to a " +
            "non-loopback address exposes that to anything that can reach this machine. If you are " +
            "certain (a container with its own network boundary, for example), re-run with --yes-i-know.",
        },
      );
    }
    warn(`binding to ${host} — the Kodo agent is now reachable from outside this machine.`);
    warn("Anything that can reach this port can edit your files and run commands as you.");
  }
  return { host, port };
}

async function startAction(flags, name) {
  const workspace = detectWorkspace(flags.cwd);
  if (!workspace.exists) throw usageError(`Directory does not exist: ${workspace.path}`);

  const { config, sources } = resolveConfig({
    workspace: workspace.path,
    cliFlags: { model: flags.model, permission: flags.permission },
  });
  const { host, port } = resolveBind(flags, config, name);

  const already = lifecycle.status(name);
  if (already.running) {
    // THE WORKSPACE INVARIANT.
    //
    // A running server is bound to the directory it was started in — that is
    // baked into its process environment (WORKSPACE_PATH) and cannot be
    // retargeted from here. Reporting "already running" for a DIFFERENT project
    // is how `cd ~/project-b && kodo ui start` used to hand back a working UI
    // whose agent then read and WROTE files in ~/project-a.
    //
    // Refusing is the only honest answer. Kodo does not guess which project you
    // meant, and it does not quietly retarget a server that other work may
    // already be running against.
    const boundTo = already.record?.workspace;
    if (boundTo && path.resolve(boundTo) !== path.resolve(workspace.path)) {
      throw runtimeError(
        `Kodo ${name} is already running for a different project: ${displayPath(boundTo)}.`,
        `To use ${displayPath(workspace.path)} instead, stop it first: kodo ui stop && kodo server stop`,
      );
    }
    if (flags.json) { out(JSON.stringify({ ok: true, alreadyRunning: true, ...already.record, url: already.url })); return EXIT.OK; }
    log(`Kodo ${name} is already running.`);
    log("");
    log(kv([["Local", style.cyan(already.url)], ["PID", already.record.pid]]));
    log("");
    if (flags.open) await openBrowser(`${already.url}/#token=${already.record.token}`);
    return EXIT.OK;
  }

  // The servers do NOT require a configured model to START.
  //
  // Requiring one made `kodo ui start` fail on a fresh install with "No model
  // is configured" — which is exactly backwards: the UI's settings page is
  // where a new user configures their provider, so demanding it beforehand
  // locks them out of the screen that fixes it. An agent RUN still requires
  // credentials and still fails clearly without them; starting a web server
  // does not.
  const modelRoute = inspectModelRoute(config).ok ? buildModelRoute(config) : { ok: false };

  // `kodo server` manages the API alone. `kodo ui` is the browser experience,
  // which needs an API to talk to — so it brings one up first if none is
  // running. That ordering is the architecture:
  //     Kodo Core → Local API → Next.js UI
  let apiRecord = null;
  if (name === "ui") {
    apiRecord = await ensureApi({ flags, config, sources, workspace, modelRoute });
  }

  // Factories, not values: the port is only known after lifecycle resolves it
  // (see --port 0).
  const service = name === "server"
    ? (resolved) => apiService({ ...resolved, workspace: workspace.path })
    : resolveUiService({ flags, apiRecord });

  const result = await lifecycle.start({
    name,
    host,
    port,
    workspace: workspace.path,
    modelRoute,
    permissionMode: config.permission || "auto",
    detach: Boolean(flags.detach),
    service,
  });

  // One helper for start and restart, so the two can never disagree about what
  // URL to hand the user. See browseUrl().
  const urlWithToken = browseUrl({ result, apiRecord, workspace: workspace.path });

  if (flags.json) {
    // The token IS returned here — a machine caller needs it to use the API,
    // and this is stdout going to that caller, not a log.
    out(JSON.stringify({ ok: true, started: true, ...result.record, url: result.url, tokenUrl: urlWithToken }));
  } else {
    log("");
    ok(`Kodo ${name} started`);
    log("");
    log(kv([
      ["Local", style.cyan(urlWithToken)],
      ["PID", result.record.pid],
      ["Workspace", displayPath(workspace.path)],
    ]));
    log("");
    if (!inspectModelRoute(config).ok) {
      log(style.yellow("  No model is configured yet — open the URL above and set your"));
      log(style.yellow("  provider and API key in Settings, or run `kodo config set model <name>`."));
      log("");
    }
  }

  if (flags.open) await openBrowser(urlWithToken);

  if (flags.detach) {
    if (!flags.json) log(style.dim(`  Running in the background. Stop it with \`kodo ${name} stop\`.`));
    return EXIT.OK;
  }

  // Attached: hold the terminal, and make Ctrl+C actually stop the server
  // rather than orphaning it.
  if (!flags.json) log(style.dim("  Press Ctrl+C to stop."));
  return holdUntilInterrupted(name);
}

function holdUntilInterrupted(name) {
  return new Promise((resolve) => {
    let stopping = false;
    const handler = async () => {
      if (stopping) return;
      stopping = true;
      log("");
      log(style.dim(`  stopping Kodo ${name}…`));
      const result = await lifecycle.stop(name).catch((err) => ({ stopped: false, reason: err.message }));
      if (result.stopped) ok(`Kodo ${name} stopped`);
      else log(style.yellow(`  could not confirm shutdown${result.reason ? ` (${result.reason})` : ""}`));
      resolve(EXIT.OK);
    };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
    process.on("SIGHUP", handler);
  });
}

async function stopAction(flags, name) {
  const result = await lifecycle.stop(name);

  if (flags.json) {
    out(JSON.stringify({ ok: true, ...result }));
    return EXIT.OK;
  }

  if (!result.wasRunning) {
    if (result.reason === "stale_state_cleared") {
      log(`Kodo ${name} is not running.`);
      log(style.dim("  (cleared a stale runtime record left by a previous crash)"));
    } else if (result.reason === "identity_mismatch") {
      log(`Kodo ${name} is not running.`);
      warn(
        "A runtime record existed but the process it named is not Kodo — most likely the PID was " +
        "reused by an unrelated process. Nothing was signalled; the stale record has been cleared.",
      );
    } else {
      log(`Kodo ${name} is not running.`);
    }
    return EXIT.OK;
  }

  if (!result.stopped) {
    throw runtimeError(`Kodo ${name} did not stop.`, `Its PID is still alive. Check ${path.join(logsDir(), `${name}.log`)}.`);
  }

  ok(`Kodo ${name} stopped${result.escalated ? " (forced after the grace period)" : ""}`);

  // `kodo ui start` may have started the API. Stopping only the UI leaves it
  // running, which is usually right — the extension and other clients may be
  // using it — but silently is not: a user who thinks they stopped Kodo should
  // be told what is still up, and how to stop it.
  if (name === "ui") {
    const api = lifecycle.status("server");
    if (api.running) {
      log(style.dim(`  The Kodo API is still running on ${api.url} (other clients may be using it).`));
      log(style.dim("  Stop it with `kodo server stop`."));
    }
  }
  return EXIT.OK;
}

async function restartAction(flags, name) {
  const workspace = detectWorkspace(flags.cwd);
  const { config, sources } = resolveConfig({
    workspace: workspace.path,
    cliFlags: { model: flags.model, permission: flags.permission },
  });
  const { host, port } = resolveBind(flags, config, name);
  const modelRoute = inspectModelRoute(config).ok ? buildModelRoute(config) : { ok: false };

  // Restart must reassemble the SAME stack that `start` does. It previously
  // called lifecycle.restart with no service descriptor, which meant every
  // `kodo ui restart` silently swapped the real Next.js UI for the built-in
  // fallback page — and printed a URL with no API origin, so the page then
  // talked to nothing. A restart that quietly changes what you are running is
  // worse than one that fails.
  let apiRecord = null;
  if (name === "ui") {
    apiRecord = await ensureApi({ flags, config, sources, workspace, modelRoute });
  }

  const service = name === "server"
    ? (resolved) => apiService({ ...resolved, workspace: workspace.path })
    : resolveUiService({ flags, apiRecord });

  const result = await lifecycle.restart({
    name, host, port,
    workspace: workspace.path,
    modelRoute,
    permissionMode: config.permission || "auto",
    detach: true,     // a restart that dies with your terminal is not a restart
    service,
  });

  const url = browseUrl({ result, apiRecord, workspace: workspace.path });

  if (flags.json) {
    out(JSON.stringify({
      ok: true, restarted: result.restarted, ...redactRecord(result.record),
      url: result.url, tokenUrl: url,
    }));
    return EXIT.OK;
  }
  ok(`Kodo ${name} ${result.restarted ? "restarted" : "started"}`);
  log("");
  log(kv([["Local", style.cyan(url)], ["PID", result.record.pid]]));
  log("");
  if (flags.open) await openBrowser(url);
  return EXIT.OK;
}

/**
 * The URL a human should open.
 *
 * The token rides in the FRAGMENT (never sent to a server, absent from logs and
 * Referer headers); the API origin rides in the QUERY, because the Next.js
 * pages are statically prerendered and cannot read it from the server's
 * environment at request time. app/lib/api.ts refuses any non-loopback value.
 */
function browseUrl({ result, apiRecord, workspace }) {
  const apiQuery = apiRecord
    ? `?kodoApi=${encodeURIComponent(`http://${apiRecord.host}:${apiRecord.port}`)}`
    : "";
  // The API's session token, NOT result.token — the UI service's lifecycle
  // token is process bookkeeping and means nothing to the API. See session.mjs.
  const token = readApiSessionToken(workspace);
  return `${result.url}/${apiQuery}${token ? `#token=${token}` : ""}`;
}

async function statusAction(flags, name) {
  const s = lifecycle.status(name);

  if (flags.json) {
    out(JSON.stringify(s.running
      ? { ok: true, running: true, ...redactRecord(s.record), url: s.url, uptimeMs: s.uptimeMs }
      : { ok: true, running: false }));
    return EXIT.OK;
  }

  log(style.bold(`Kodo ${name}`));
  log("");
  if (!s.running) {
    log(kv([["Status", style.dim("stopped")]]));
    if (s.reclaimedStale) log(style.dim("  (a stale runtime record from a previous crash was cleared)"));
    log("");
    return EXIT.OK;
  }

  log(kv([
    ["Status", style.green("running")],
    ["PID", s.record.pid],
    ["Host", s.record.host],
    ["Port", s.record.port],
    ["URL", style.cyan(s.url)],
    ["Workspace", displayPath(s.record.workspace || "")],
    ["Version", s.record.version || "unknown"],
    ["Uptime", humanDuration(s.uptimeMs)],
  ]));
  log("");
  return EXIT.OK;
}

/** The runtime token is a credential; status output must not carry it. */
function redactRecord(record) {
  const { token, ...rest } = record || {};
  return rest;
}

async function logsAction(flags, name) {
  const file = path.join(logsDir(), `${name}.log`);
  out(file);
  return EXIT.OK;
}

async function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
    : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // Opening a browser is a convenience; failing to is not an error worth
    // taking the command down for.
    warn(`could not open a browser — visit ${url}`);
  }
}
