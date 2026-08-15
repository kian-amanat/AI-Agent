/**
 * src/commands/status.mjs — `kodo status`.
 *
 * A fast, credential-free snapshot: version, workspace, model, server state.
 * Unlike `doctor` it makes no network calls, so it stays usable as something
 * you can put in a prompt or a watch loop.
 */

import { parseArgs } from "../args.mjs";
import { EXIT } from "../exit.mjs";
import { resolveConfig } from "../config.mjs";
import { inspectModelRoute } from "../creds.mjs";
import { detectWorkspace, displayPath } from "../workspace.mjs";
import { coreVersion } from "../core.mjs";
import * as lifecycle from "../runtime/lifecycle.mjs";
import * as sessions from "../sessions.mjs";
import { out, log, style, kv, humanDuration } from "../term.mjs";

const SPEC = {
  cwd:     { type: "string" },
  json:    { type: "boolean" },
  help:    { type: "boolean", short: "h" },
  color:   { type: "boolean", default: true },
  verbose: { type: "boolean" },
  debug:   { type: "boolean" },
};

export async function statusCommand({ argv, version }) {
  const { flags } = parseArgs(argv, SPEC);
  const workspace = detectWorkspace(flags.cwd);
  const { config } = resolveConfig({ workspace: workspace.path });
  const route = inspectModelRoute(config);

  const ui = lifecycle.status("ui");
  const server = lifecycle.status("server");
  const all = sessions.list();
  const active = all.filter((s) => s.status === "active");

  if (flags.json) {
    out(JSON.stringify({
      ok: true,
      version,
      core: await coreVersion(),
      runtime: process.version,
      workspace: workspace.path,
      git: workspace.git,
      // Model and provider only — never the key, not even in JSON.
      model: route.ok ? route.model : null,
      provider: route.ok ? (route.provider || route.baseUrl) : null,
      configured: route.ok,
      permission: config.permission || "auto",
      ui: ui.running ? { running: true, url: ui.url, pid: ui.record.pid, uptimeMs: ui.uptimeMs } : { running: false },
      server: server.running ? { running: true, url: server.url, pid: server.record.pid } : { running: false },
      sessions: { total: all.length, active: active.length },
    }, null, 2));
    return EXIT.OK;
  }

  log(style.bold("Kodo"));
  log("");
  log(kv([
    ["Version", version],
    ["Runtime", `Node.js ${process.version}`],
    ["Workspace", displayPath(workspace.path)],
    ["Git", workspace.git ? `${workspace.git.branch} ${workspace.git.clean ? "(clean)" : `(${workspace.git.dirtyFiles} uncommitted)`}` : style.dim("not detected")],
    ["Model", route.ok ? route.model : style.yellow("not configured")],
    ["Permission", config.permission || "auto"],
  ]));
  log("");
  log(style.dim("UI:"));
  log(ui.running
    ? kv([["status", style.green("running")], ["url", style.cyan(ui.url)], ["pid", ui.record.pid], ["uptime", humanDuration(ui.uptimeMs)]], "    ")
    : "    stopped");
  log("");
  log(style.dim("Server:"));
  log(server.running
    ? kv([["status", style.green("running")], ["url", style.cyan(server.url)], ["pid", server.record.pid]], "    ")
    : "    stopped");
  log("");
  log(style.dim("Sessions:"));
  log(`    ${all.length} total, ${active.length} active`);
  log("");

  if (!route.ok) {
    log(style.yellow(`  ${route.reason}`));
    if (route.hint) log(style.dim(`  ${route.hint}`));
    log("");
  }
  return EXIT.OK;
}
