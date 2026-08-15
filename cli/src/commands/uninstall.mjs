/**
 * src/commands/uninstall.mjs — `kodo uninstall`.
 *
 * Removal is scoped, explicit, and confirmed. Three separable things exist and
 * conflating them is how a tool deletes something a user wanted:
 *
 *   launcher   the `kodo` executable on your PATH
 *   cache      logs, runtime state, saved sessions   (~/.kodo/{logs,runtime,sessions})
 *   config     your API key, model, preferences      (~/.kodo/config.json)
 *
 * Defaults to removing the launcher only. `~/.kodo` is NEVER removed without an
 * explicit flag AND a typed confirmation, because it holds the credential the
 * user configured and re-entering it is the one part of setup they cannot get
 * back from a reinstall.
 *
 * Project files — the checkout, `.kodo/` inside a repository, KODO.md — are
 * never touched. Those are the user's work, not Kodo's installation.
 */

import fs from "fs";
import path from "path";
import readline from "readline";

import { parseArgs } from "../args.mjs";
import { EXIT, CliError } from "../exit.mjs";
import { out, log, style, ok, warn } from "../term.mjs";
import { kodoHome, logsDir, runtimeDir, sessionsDir, userConfigPath } from "../paths.mjs";
import { detectInstallation } from "./update.mjs";
import * as lifecycle from "../runtime/lifecycle.mjs";

const SPEC = {
  all:     { type: "boolean" },
  cache:   { type: "boolean" },
  config:  { type: "boolean" },
  yes:     { type: "boolean", short: "y" },
  json:    { type: "boolean" },
  help:    { type: "boolean", short: "h" },
  color:   { type: "boolean", default: true },
  verbose: { type: "boolean" },
  debug:   { type: "boolean" },
};

function findLauncher() {
  // Look for the launcher that is ACTUALLY on PATH first.
  //
  // Guessing from a fixed list of directories missed any install with a custom
  // KODO_INSTALL_DIR — `kodo uninstall` then reported "no launcher found" while
  // the user was running that very launcher. Resolving it from PATH finds the
  // one that would run, which is the one being uninstalled.
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, process.platform === "win32" ? "kodo.cmd" : "kodo");
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch { /* unreadable PATH entry */ }
  }

  const candidates = [
    process.env.KODO_INSTALL_DIR && path.join(process.env.KODO_INSTALL_DIR, "kodo"),
    path.join(process.env.HOME || "", ".local", "bin", "kodo"),
    path.join(process.env.HOME || "", "bin", "kodo"),
  ].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c)) || null;
}

function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    try {
      total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
    } catch { /* vanished mid-walk */ }
  }
  return total;
}

const human = (bytes) => (bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`);

function confirm(question, expected) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`${question} `, (answer) => {
      rl.close();
      resolve(String(answer).trim() === expected);
    });
  });
}

export async function uninstallCommand({ argv }) {
  const { flags } = parseArgs(argv, SPEC);

  const removeCache = Boolean(flags.all || flags.cache);
  const removeConfig = Boolean(flags.all || flags.config);
  const launcher = findLauncher();
  const install = detectInstallation();

  if (flags.json) {
    out(JSON.stringify({
      ok: true,
      launcher,
      kodoHome: kodoHome(),
      wouldRemove: {
        launcher: Boolean(launcher),
        cache: removeCache,
        config: removeConfig,
      },
      sourceCheckout: install.root,
    }, null, 2));
    return EXIT.OK;
  }

  log("");
  log(style.bold("Kodo uninstall"));
  // npm owns an npm-installed CLI. Deleting its files behind its back leaves
  // npm's metadata claiming a package that is no longer there, and the next
  // `npm install -g` silently "repairs" it. So for an npm install, Kodo removes
  // only ITS OWN data and hands the package back to npm with the exact command.
  if (install.kind === "npm") {
    const pkg = install.packageName || "kodo-agent";
    const npmCommand = `npm uninstall ${install.global ? "-g " : ""}${pkg}`;

    log("");
    log("  Kodo was installed by npm, so npm removes it:");
    log("");
    log(`      ${style.bold(npmCommand)}`);
    log("");
    log("  This command will NOT remove the package — npm manages those files.");
    log("");
    log("  It can remove Kodo's own data:");
    log(removeCache
      ? `    · logs, runtime state and sessions   ${kodoHome()}`
      : style.dim("    · logs/sessions               (add --cache)"));
    log(removeConfig
      ? `    · your configuration ${style.yellow("(including your API key)")}   ${userConfigPath()}`
      : style.dim("    · configuration and API key   (add --config)"));
    log("");

    if (!removeCache && !removeConfig) {
      log(style.dim("  Nothing to do. Run the npm command above to remove the CLI itself."));
      log("");
      return EXIT.OK;
    }

    if (removeConfig && !flags.yes) {
      const typed = await confirm(
        `  Type ${style.bold("remove my configuration")} to confirm:`,
        "remove my configuration",
      );
      if (!typed) { log(""); log("  Cancelled. Nothing was removed."); log(""); return EXIT.OK; }
    }

    if (removeCache) {
      for (const dir of [logsDir(), runtimeDir(), sessionsDir()]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); ok(`removed ${dir}`); }
        catch (err) { warn(`could not remove ${dir}: ${err.message}`); }
      }
    }
    if (removeConfig) {
      try { fs.rmSync(userConfigPath(), { force: true }); ok(`removed ${userConfigPath()}`); }
      catch (err) { warn(`could not remove ${userConfigPath()}: ${err.message}`); }
    }

    log("");
    log(`  Now remove the CLI itself:   ${style.bold(npmCommand)}`);
    log("");
    return EXIT.OK;
  }

  log("");
  log("  This will remove:");
  log(launcher ? `    · the launcher   ${launcher}` : style.dim("    · (no launcher found on PATH)"));
  if (removeCache) {
    log(`    · logs, runtime state and sessions   ${kodoHome()} ${style.dim(`(${human(dirSize(logsDir()) + dirSize(runtimeDir()) + dirSize(sessionsDir()))})`)}`);
  }
  if (removeConfig) {
    log(`    · your configuration ${style.yellow("(including your API key)")}   ${userConfigPath()}`);
  }
  log("");
  log("  This will NOT remove:");
  if (!removeCache) log(style.dim(`    · ${kodoHome()} (use --cache to remove logs/sessions)`));
  if (!removeConfig) log(style.dim(`    · your configuration (use --config to remove it)`));
  if (install.kind === "release") {
    log(`    · the installed files   ${install.root} ${style.dim(`(${human(dirSize(install.root))})`)}`);
  } else if (install.root) {
    log(style.dim(`    · the source checkout at ${install.root}`));
  }
  log(style.dim("    · anything in your projects — .kodo/, KODO.md and your code are untouched"));
  log("");

  // Removing config is the irreversible one: an API key cannot be recovered by
  // reinstalling. It requires typing the word, not just pressing y.
  if (removeConfig && !flags.yes) {
    if (!process.stdin.isTTY) {
      throw new CliError(
        "Refusing to remove your configuration without confirmation.",
        EXIT.PERMISSION,
        { hint: "Re-run interactively, or pass --yes if you are certain." },
      );
    }
    const okToGo = await confirm(
      `${style.yellow("?")} This deletes your saved API key. Type ${style.bold("remove")} to confirm:`,
      "remove",
    );
    if (!okToGo) {
      log("");
      log("  Cancelled. Nothing was removed.");
      log("");
      return EXIT.OK;
    }
  } else if (!flags.yes && process.stdin.isTTY) {
    const okToGo = await confirm(`${style.yellow("?")} Continue? [y/N]`, "y");
    if (!okToGo) {
      log("");
      log("  Cancelled. Nothing was removed.");
      log("");
      return EXIT.OK;
    }
  }

  // Stop anything still running, so uninstalling does not orphan a server.
  for (const name of ["ui", "server"]) {
    const status = lifecycle.status(name);
    if (status.running) {
      log(style.dim(`  stopping the ${name} server…`));
      await lifecycle.stop(name).catch(() => {});
    }
  }

  if (launcher) {
    try {
      fs.unlinkSync(launcher);
      ok(`removed ${launcher}`);
    } catch (err) {
      warn(`could not remove ${launcher}: ${err.message}`);
    }
  }

  if (removeCache) {
    for (const dir of [logsDir(), runtimeDir(), sessionsDir()]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
    }
    ok("removed logs, runtime state and sessions");
  }

  if (removeConfig) {
    try { fs.rmSync(userConfigPath(), { force: true }); ok("removed your configuration"); }
    catch (err) { warn(`could not remove the config file: ${err.message}`); }
  }

  // Only remove ~/.kodo itself if it is now empty — never blind-delete a
  // directory that may hold something we did not enumerate above.
  if (removeCache && removeConfig) {
    try {
      if (fs.readdirSync(kodoHome()).length === 0) {
        fs.rmdirSync(kodoHome());
        ok(`removed ${kodoHome()}`);
      } else {
        log(style.dim(`  ${kodoHome()} still contains other files and was left in place.`));
      }
    } catch { /* already gone */ }
  }

  log("");
  if (install.root) {
    if (install.kind === "release") {
      // Kodo created this directory, so Kodo removes it. Leaving 55 MB of
      // installed files behind after "uninstall" is not an uninstall.
      try {
        fs.rmSync(install.root, { recursive: true, force: true });
        ok(`removed ${install.root}`);
      } catch (err) {
        warn(`could not remove ${install.root}: ${err.message}`);
      }
    } else if (install.root) {
      log(style.dim(`  The source checkout at ${install.root} was left alone — delete it yourself if you want it gone.`));
    }
  }
  log("");
  return EXIT.OK;
}
