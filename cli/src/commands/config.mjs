/**
 * src/commands/config.mjs — `kodo config get|set|list|path`.
 *
 * Reading configuration must never disclose a credential. Every path out of
 * this command goes through the redaction in ../config.mjs, including
 * `config get apiKey` — if you need the real value you already have it, and if
 * you do not, printing it into a terminal (and a shell history, and a CI log)
 * is how it leaks.
 */

import { parseArgs } from "../args.mjs";
import { EXIT, usageError } from "../exit.mjs";
import {
  coerceValue, flatten, getPath, isSecretKey, loadUserConfig,
  maskSecret, resolveConfig, saveUserConfig, setPath,
} from "../config.mjs";
import { detectWorkspace } from "../workspace.mjs";
import { userConfigPath } from "../paths.mjs";
import { out, log, style, ok } from "../term.mjs";

const SPEC = {
  cwd:    { type: "string" },
  json:   { type: "boolean" },
  global: { type: "boolean", default: true },
  help:   { type: "boolean", short: "h" },
  color:  { type: "boolean", default: true },
  verbose: { type: "boolean" },
  debug:  { type: "boolean" },
};

export async function configCommand({ argv }) {
  const { flags, positional } = parseArgs(argv, SPEC);
  const [action = "list", key, ...rest] = positional;

  const workspace = detectWorkspace(flags.cwd);

  if (action === "path") {
    out(userConfigPath());
    return EXIT.OK;
  }

  if (action === "list") {
    const { config, sources } = resolveConfig({ workspace: workspace.path });
    if (flags.json) {
      // Even in JSON mode: masked. A machine consumer has no more right to the
      // key than a human one, and this output ends up in CI logs.
      out(JSON.stringify(Object.fromEntries(flatten(config)), null, 2));
      return EXIT.OK;
    }
    log(style.bold("Effective configuration"));
    log(style.dim(`  user file: ${userConfigPath()}`));
    log("");
    for (const [k, v] of flatten(config)) {
      const source = sources[k.split(".")[0]] || "default";
      out(`  ${k.padEnd(22)} ${String(v)} ${style.dim(`(${source})`)}`);
    }
    log("");
    log(style.dim("  Secrets are masked. Precedence: arguments > project > user > environment > defaults."));
    return EXIT.OK;
  }

  if (action === "get") {
    if (!key) throw usageError("Usage: kodo config get <key>");
    const { config } = resolveConfig({ workspace: workspace.path });
    const value = getPath(config, key);
    if (value === undefined) {
      log(style.dim(`(not set)`));
      return EXIT.OK;
    }
    out(isSecretKey(key) ? maskSecret(value) : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value));
    return EXIT.OK;
  }

  if (action === "set") {
    if (!key || rest.length === 0) throw usageError("Usage: kodo config set <key> <value>");
    const raw = rest.join(" ");
    const config = loadUserConfig();
    setPath(config, key, coerceValue(raw));
    const file = saveUserConfig(config);
    // Confirm the write without echoing what was written.
    ok(`set ${key} = ${isSecretKey(key) ? maskSecret(raw) : raw}`);
    log(style.dim(`  ${file}`));
    return EXIT.OK;
  }

  if (action === "unset") {
    if (!key) throw usageError("Usage: kodo config unset <key>");
    const config = loadUserConfig();
    setPath(config, key, undefined);
    saveUserConfig(config);
    ok(`unset ${key}`);
    return EXIT.OK;
  }

  throw usageError(
    `Unknown config action "${action}".`,
    "Valid actions: get, set, unset, list, path",
  );
}
