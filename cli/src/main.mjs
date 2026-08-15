/**
 * src/main.mjs — dispatch.
 *
 * Every command is loaded lazily. `kodo ui stop` must not import LangGraph, and
 * `kodo --version` must not import anything that can fail on an unconfigured
 * machine — those are exactly the commands you reach for when something is
 * already broken.
 */

import { createRequire } from "module";
import path from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { CliError, EXIT } from "./exit.mjs";
import { setColor, setDebug, log, style, out, banner } from "./term.mjs";
import { generalHelp, helpFor, helpCommand } from "./commands/help.mjs";

const require = createRequire(import.meta.url);

/**
 * The CLI's version, resolved by walking UP for the nearest package.json.
 *
 * A fixed `../package.json` worked in the repository (cli/package.json) and
 * broke the moment the package was installed, where the manifest sits at the
 * package ROOT — two levels up from cli/src. `kodo --version` then crashed with
 * MODULE_NOT_FOUND on a globally installed Kodo, which is both the first thing
 * a user runs and the last place you want a stack trace.
 *
 * Walking up handles both layouts without either knowing about the other.
 */
function resolveVersion() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = require(candidate);
        if (pkg.version) return pkg.version;
      } catch { /* unreadable — keep walking */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0-unknown";
}

export const CLI_VERSION = resolveVersion();

/** Flags handled before any command sees them. */
function extractGlobals(argv) {
  const rest = [];
  const globals = { help: false, version: false, color: true, debug: false, verbose: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") { globals.help = true; continue; }
    if (arg === "--version" || arg === "-V") { globals.version = true; continue; }
    // `-v` is version at the top level only; inside a command it may mean
    // something else, so it is not consumed once a command name is known.
    if (arg === "-v" && rest.length === 0) { globals.version = true; continue; }
    if (arg === "--no-color") { globals.color = false; continue; }
    if (arg === "--debug") { globals.debug = true; rest.push(arg); continue; }
    if (arg === "--verbose") { globals.verbose = true; rest.push(arg); continue; }
    rest.push(arg);
  }
  return { globals, rest };
}

const ALIASES = {
  "--version": "version",
  ls: "sessions",
  serve: "ui",
};

export async function main(argv = process.argv.slice(2)) {
  const { globals, rest } = extractGlobals(argv);
  setColor(globals.color);
  setDebug(globals.debug);

  if (globals.version) { out(CLI_VERSION); return EXIT.OK; }

  // .env before anything resolves configuration — see ensureEnvLoaded().
  // Skipped for the two commands that must work on a broken install and read
  // no credentials at all.
  if (rest[0] !== "help" && rest[0] !== "completion") {
    const { ensureEnvLoaded } = await import("./core.mjs");
    await ensureEnvLoaded();
  }

  const raw = rest[0];
  const command = ALIASES[raw] || raw;
  const args = rest.slice(1);

  // Bare `kodo` — interactive when there is a terminal to be interactive with;
  // help when there is not, because a piped `kodo` that silently waits for
  // stdin looks like a hang.
  if (!command) {
    if (globals.help) { out(generalHelp(CLI_VERSION)); return EXIT.OK; }
    if (!process.stdin.isTTY) { out(generalHelp(CLI_VERSION)); return EXIT.OK; }
    const { chatCommand } = await import("./commands/chat.mjs");
    return chatCommand({ argv: args });
  }

  // `kodo <cmd> --help` prints that command's help without running it.
  if (globals.help) {
    const text = helpFor(command);
    if (text) { out(text); return EXIT.OK; }
    out(generalHelp(CLI_VERSION));
    return EXIT.OK;
  }

  switch (command) {
    case "help":
      return helpCommand({ positional: args, version: CLI_VERSION });

    case "version": {
      // Report core too: a CLI and a core at different versions is a real and
      // confusing failure mode, so it is surfaced rather than discovered later.
      const { coreVersion } = await import("./core.mjs");
      const core = await coreVersion();
      if (args.includes("--json")) {
        out(JSON.stringify({ cli: CLI_VERSION, core, node: process.version }));
        return EXIT.OK;
      }
      out(CLI_VERSION);
      if (core && core !== CLI_VERSION) {
        log(style.yellow(`warning: Kodo Core is v${core} but this CLI is v${CLI_VERSION}. Reinstall Kodo.`));
      }
      return EXIT.OK;
    }

    case "chat": {
      const { chatCommand } = await import("./commands/chat.mjs");
      return chatCommand({ argv: args });
    }

    case "resume": {
      const { chatCommand } = await import("./commands/chat.mjs");
      const id = args.find((a) => !a.startsWith("-"));
      if (!id) throw new CliError("Usage: kodo resume <id>", EXIT.USAGE, { hint: "Run `kodo sessions` to see them." });
      return chatCommand({ argv: args.filter((a) => a !== id), resumeId: id });
    }

    case "run": {
      const { runCommand } = await import("./commands/run.mjs");
      return runCommand({ argv: args });
    }

    case "init": {
      const { initCommand } = await import("./commands/init.mjs");
      return initCommand({ argv: args });
    }

    case "config": {
      const { configCommand } = await import("./commands/config.mjs");
      return configCommand({ argv: args });
    }

    case "ui":
    case "server": {
      const { uiCommand } = await import("./commands/ui.mjs");
      return uiCommand({ argv: args, name: command });
    }

    case "status": {
      const { statusCommand } = await import("./commands/status.mjs");
      return statusCommand({ argv: args, version: CLI_VERSION });
    }

    case "doctor": {
      const { doctorCommand } = await import("./commands/doctor.mjs");
      return doctorCommand({ argv: args, version: CLI_VERSION });
    }

    case "sessions": {
      const { sessionsCommand } = await import("./commands/sessions.mjs");
      return sessionsCommand({ argv: args });
    }

    case "update": {
      const { updateCommand } = await import("./commands/update.mjs");
      return updateCommand({ argv: args, version: CLI_VERSION });
    }

    case "uninstall": {
      const { uninstallCommand } = await import("./commands/uninstall.mjs");
      return uninstallCommand({ argv: args });
    }

    case "completion": {
      const { completionCommand } = await import("./commands/completion.mjs");
      return completionCommand({ argv: args });
    }

    default:
      throw new CliError(
        `Unknown command "${command}".`,
        EXIT.USAGE,
        { hint: "Run `kodo help` to see the available commands." },
      );
  }
}

/** Turn any thrown value into an exit code and a message a human can act on. */
export function reportError(err) {
  if (err instanceof CliError) {
    log(`${style.red("error")} ${err.message}`);
    if (err.hint) log(style.dim(`  ${err.hint}`));
    return err.code;
  }
  log(`${style.red("error")} ${err?.message || String(err)}`);
  if (process.env.KODO_DEBUG || process.argv.includes("--debug")) {
    log(style.gray(err?.stack || ""));
  } else {
    log(style.dim("  Run with --debug for a stack trace, or `kodo doctor` to check your installation."));
  }
  return EXIT.RUNTIME;
}

export { banner };
