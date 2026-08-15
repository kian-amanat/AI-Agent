/**
 * src/args.mjs — argument parsing.
 *
 * Hand-rolled rather than reaching for commander/yargs. The repository already
 * parses argv this way in bench/cli.mjs, ships zero CLI dependencies, and a
 * dependency here would have to be vendored into every installed copy of Kodo
 * for no behaviour we don't already need. What this adds over bench's parser is
 * the part that actually matters for a user-facing tool: a declared spec, so an
 * unknown or malformed flag is a usage ERROR instead of being silently ignored.
 *
 * Supported forms:
 *   --flag              boolean true
 *   --no-flag           boolean false
 *   --key value         string / number
 *   --key=value         string / number
 *   -k value            short alias
 *   --                  everything after is positional, never parsed
 */

import { usageError } from "./exit.mjs";

/**
 * @param {string[]} argv
 * @param {Record<string, {type?: "string"|"number"|"boolean", short?: string, default?: any}>} spec
 */
export function parseArgs(argv, spec = {}) {
  const byShort = new Map();
  for (const [name, def] of Object.entries(spec)) {
    if (def.short) byShort.set(def.short, name);
  }

  const flags = {};
  const positional = [];
  let passthroughOnly = false;

  const define = (name, raw) => {
    const def = spec[name];
    if (!def) {
      throw usageError(`Unknown option --${name}`, `Run \`kodo help\` to see what this command accepts.`);
    }
    if (def.type === "number") {
      const n = Number(raw);
      // Port 0 is meaningful ("pick a free one"), so this checks for NaN
      // specifically rather than falsiness.
      if (!Number.isFinite(n)) throw usageError(`--${name} expects a number, got "${raw}"`);
      flags[name] = n;
      return;
    }
    flags[name] = def.type === "boolean" ? raw !== false && raw !== "false" : String(raw);
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (passthroughOnly) { positional.push(arg); continue; }
    if (arg === "--") { passthroughOnly = true; continue; }

    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");

      if (eq !== -1) { define(body.slice(0, eq), body.slice(eq + 1)); continue; }

      if (body.startsWith("no-") && spec[body.slice(3)]?.type === "boolean") {
        flags[body.slice(3)] = false;
        continue;
      }

      const def = spec[body];
      if (!def) throw usageError(`Unknown option --${body}`, "Run `kodo help` to see what this command accepts.");
      if (def.type === "boolean") { flags[body] = true; continue; }

      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("-") && next !== "-" && Number.isNaN(Number(next)))) {
        throw usageError(`--${body} expects a value`);
      }
      define(body, next);
      i++;
      continue;
    }

    // A lone "-" is a conventional stdin marker, not a flag.
    if (arg.startsWith("-") && arg.length > 1) {
      const short = arg.slice(1);
      const name = byShort.get(short);
      if (!name) throw usageError(`Unknown option -${short}`);
      if (spec[name].type === "boolean") { flags[name] = true; continue; }
      const next = argv[i + 1];
      if (next === undefined) throw usageError(`-${short} expects a value`);
      define(name, next);
      i++;
      continue;
    }

    positional.push(arg);
  }

  for (const [name, def] of Object.entries(spec)) {
    if (!(name in flags) && def.default !== undefined) flags[name] = def.default;
  }

  return { flags, positional };
}

/**
 * Global options every command accepts. Kept in one place so `--json` means the
 * same thing everywhere and `--debug` can be honoured before any command runs.
 */
export const GLOBAL_SPEC = {
  help:    { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  verbose: { type: "boolean" },
  debug:   { type: "boolean" },
  json:    { type: "boolean" },
  color:   { type: "boolean", default: true },
};
