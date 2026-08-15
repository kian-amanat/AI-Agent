/**
 * src/commands/doctor.mjs — `kodo doctor`.
 *
 * The command people run when something is wrong, so it has two hard rules:
 *   1. It must work on a BROKEN installation. Every check is independently
 *      guarded — a missing core, an unparseable config or an unreachable
 *      provider produces a failed check, never a stack trace that hides the
 *      other fifteen results.
 *   2. It must never print a credential. It reports whether a key is present
 *      and whether it works, never what it is.
 */

import { execFile } from "child_process";
import fs from "fs";
import { promisify } from "util";

import { parseArgs } from "../args.mjs";
import { EXIT } from "../exit.mjs";
import { resolveConfig } from "../config.mjs";
import { inspectModelRoute } from "../creds.mjs";
import { detectWorkspace, displayPath } from "../workspace.mjs";
import { coreEntry, loadCore } from "../core.mjs";
import { kodoHome, userConfigPath, projectSettingsPath, projectInstructions } from "../paths.mjs";
import * as lifecycle from "../runtime/lifecycle.mjs";
import { out, log, style } from "../term.mjs";

const execFileAsync = promisify(execFile);

const SPEC = {
  cwd:     { type: "string" },
  json:    { type: "boolean" },
  help:    { type: "boolean", short: "h" },
  color:   { type: "boolean", default: true },
  verbose: { type: "boolean" },
  debug:   { type: "boolean" },
  timeout: { type: "number", default: 10_000 },
};

/** @returns {{name, status: "ok"|"warn"|"fail"|"skip", detail: string, optional?: boolean}} */
const check = (name, status, detail, optional = false) => ({ name, status, detail, optional });

async function guarded(name, fn, optional = false) {
  try {
    return await fn();
  } catch (err) {
    return check(name, optional ? "warn" : "fail", err.message, optional);
  }
}

async function commandExists(bin, args = ["--version"]) {
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout: 5000 });
    return String(stdout).trim().split("\n")[0];
  } catch {
    return null;
  }
}

export async function doctorCommand({ argv, version }) {
  const { flags } = parseArgs(argv, SPEC);
  const workspace = detectWorkspace(flags.cwd);
  const results = [];

  // ── Installation ───────────────────────────────────────────────────────────
  results.push(check("Node.js", nodeOk() ? "ok" : "fail",
    nodeOk() ? process.version : `${process.version} — Kodo needs Node 20.12 or newer`));

  results.push(check("Kodo CLI", "ok", `v${version}`));

  results.push(await guarded("Kodo Core", async () => {
    const entry = coreEntry();
    if (!entry) return check("Kodo Core", "fail", "not found — set KODO_CORE_PATH or reinstall");
    const core = await loadCore();
    if (core.VERSION !== version) {
      return check("Kodo Core", "warn",
        `v${core.VERSION} but the CLI is v${version} — a version mismatch can cause subtle failures. Reinstall Kodo.`);
    }
    return check("Kodo Core", "ok", `v${core.VERSION}`);
  }));

  results.push(check("Kodo home", fs.existsSync(kodoHome()) ? "ok" : "warn",
    fs.existsSync(kodoHome()) ? displayPath(kodoHome()) : `${displayPath(kodoHome())} (will be created on first use)`));

  // ── Configuration ──────────────────────────────────────────────────────────
  let config = {};
  results.push(await guarded("Configuration", async () => {
    const resolved = resolveConfig({ workspace: workspace.path });
    config = resolved.config;
    return check("Configuration", "ok",
      fs.existsSync(userConfigPath()) ? displayPath(userConfigPath()) : "defaults (no user config file yet)");
  }));

  const route = inspectModelRoute(config);
  results.push(check("Provider", route.ok ? "ok" : "fail",
    route.ok ? `${route.model} via ${route.baseUrl}` : route.reason));

  // ── Live provider probe ────────────────────────────────────────────────────
  results.push(await guarded("API connection", async () => {
    if (!route.ok) return check("API connection", "skip", "no provider configured");
    const full = resolveConfig({ workspace: workspace.path }).config;
    const key = full.apiKey || full.textApiKey;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), flags.timeout);
    try {
      const res = await fetch(`${route.baseUrl.replace(/\/$/, "")}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        return check("API connection", "fail", `the provider rejected the configured key (HTTP ${res.status})`);
      }
      if (!res.ok) return check("API connection", "warn", `HTTP ${res.status} from ${route.baseUrl}`);
      return check("API connection", "ok", `reachable (${route.baseUrl})`);
    } finally {
      clearTimeout(timer);
    }
  }));

  // ── Workspace ──────────────────────────────────────────────────────────────
  results.push(check("Workspace", workspace.exists ? "ok" : "fail", displayPath(workspace.path)));
  results.push(check("Git", workspace.git ? "ok" : "warn",
    workspace.git
      ? `${workspace.git.branch}${workspace.git.clean ? " (clean)" : ` (${workspace.git.dirtyFiles} uncommitted)`}`
      : "not a git repository — Kodo works, but you lose easy undo of its edits"));

  results.push(check("Project config", fs.existsSync(projectSettingsPath(workspace.path)) ? "ok" : "warn",
    fs.existsSync(projectSettingsPath(workspace.path)) ? ".kodo/settings.json" : "no .kodo/settings.json — run `kodo init`"));

  results.push(check("Project instructions", fs.existsSync(projectInstructions(workspace.path)) ? "ok" : "warn",
    fs.existsSync(projectInstructions(workspace.path)) ? "KODO.md" : "no KODO.md — run `kodo init`"));

  // ── MCP ────────────────────────────────────────────────────────────────────
  results.push(await guarded("MCP servers", async () => {
    const core = await loadCore();
    const probe = await core.probeMcpServers(workspace.path);
    if (!probe.configured) return check("MCP servers", "skip", "none configured");
    const up = probe.servers.filter((s) => s.ok);
    const down = probe.servers.filter((s) => !s.ok);
    if (down.length) {
      return check("MCP servers", "warn",
        `${up.length}/${probe.configured} connected — failing: ${down.map((s) => `${s.name} (${s.error || "unavailable"})`).join(", ")}`);
    }
    return check("MCP servers", "ok", `${up.length} connected`);
  }, true));

  // ── Runtime ────────────────────────────────────────────────────────────────
  for (const [name, label] of [["ui", "Kodo UI server"], ["server", "Kodo runtime server"]]) {
    const s = lifecycle.status(name);
    results.push(check(label, "ok",
      s.running ? `running on ${s.url} (pid ${s.record.pid})` : "stopped"));
  }

  // ── Optional runtimes ──────────────────────────────────────────────────────
  // Probe what the runtime layer can ACTUALLY provide, not merely whether a
  // CLI binary is on PATH. `docker` installed with the daemon stopped is the
  // common case, and reporting it as available would promise a sandbox that
  // then fails at run time.
  results.push(await guarded("Sandboxes", async () => {
    const core = await loadCore();
    const available = await core.availableSandboxes();
    // Present availability and VERIFICATION separately. "incus is installed"
    // and "incus isolation has been proven" are different facts, and merging
    // them into one cheerful list is how an unverified boundary gets used as
    // though it were a verified one.
    const advertised = new Set(
      typeof core.advertisedSandboxes === "function"
        ? await core.advertisedSandboxes()
        : ["host", "docker"],
    );
    const usable = Object.entries(available)
      .filter(([, ok]) => ok)
      .map(([name]) => (advertised.has(name) ? name : `${name} (unverified, opt-in)`));
    return check("Sandboxes", "ok", `${usable.join(", ")}`, true);
  }, true));

  const docker = await commandExists("docker");
  results.push(check("Docker", docker ? "ok" : "skip", docker || "not installed (optional)", true));

  const incus = await commandExists("incus", ["--version"]);
  results.push(check("Incus", incus ? "ok" : "skip", incus ? `incus ${incus}` : "not installed (optional)", true));

  // ── Report ─────────────────────────────────────────────────────────────────
  if (flags.json) {
    out(JSON.stringify({ ok: true, version, checks: results }, null, 2));
    return results.some((r) => r.status === "fail") ? EXIT.CONFIG : EXIT.OK;
  }

  log(style.bold("Kodo Doctor"));
  log("");
  const required = results.filter((r) => !r.optional);
  const optional = results.filter((r) => r.optional);
  for (const r of required) log(`  ${icon(r.status)} ${r.name.padEnd(22)} ${style.dim(r.detail)}`);
  if (optional.length) {
    log("");
    log(style.dim("  Optional"));
    for (const r of optional) log(`  ${icon(r.status)} ${r.name.padEnd(22)} ${style.dim(r.detail)}`);
  }
  log("");

  const failures = required.filter((r) => r.status === "fail");
  const warnings = required.filter((r) => r.status === "warn");
  if (failures.length) {
    log(style.red(`  ${failures.length} problem(s) will stop Kodo from working:`));
    for (const f of failures) log(style.red(`    · ${f.name} — ${f.detail}`));
    log("");
    return EXIT.CONFIG;
  }
  if (warnings.length) {
    log(style.green("  Everything required for Kodo is working.") + style.dim(` ${warnings.length} suggestion(s) above.`));
  } else {
    log(style.green("  Everything required for Kodo is working."));
  }
  log("");
  return EXIT.OK;
}

function nodeOk() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 20 || (major === 20 && minor >= 12);
}

function icon(status) {
  return status === "ok" ? style.green("✓")
    : status === "warn" ? style.yellow("!")
    : status === "skip" ? style.dim("–")
    : style.red("✗");
}
