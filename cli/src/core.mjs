/**
 * src/core.mjs — the CLI's only door into Kodo Core.
 *
 * Every core import in the CLI goes through here. That is what keeps the
 * "one agent" rule enforceable rather than aspirational: if a command wants
 * agent behaviour it has to come through this file, so there is no quiet path
 * by which a second, CLI-flavoured agent loop could grow.
 *
 * Core is located relative to this package by default and can be pointed
 * elsewhere with KODO_CORE_PATH — which is how the Docker image and a future
 * standalone install layout supply it without the CLI hard-coding a tree shape.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { configError } from "./exit.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cached = null;

export function coreEntry() {
  const candidates = [
    process.env.KODO_CORE_PATH,
    path.resolve(__dirname, "..", "..", "backend1", "core", "index.mjs"),
    path.resolve(__dirname, "..", "core", "index.mjs"),
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

let envLoaded = false;

/**
 * Fill process.env from the installation's .env files, the same way server.mjs
 * and bench/cli.mjs do.
 *
 * This MUST run before configuration is resolved. resolveConfig() reads
 * process.env to build its environment layer, so loading .env later — which is
 * what happened when this was buried inside loadCore() — meant a machine whose
 * credentials lived in .env resolved to "no API key configured" and every run
 * failed on auth while the key sat there in a file Kodo had already read.
 *
 * Cheap enough (two process.loadEnvFile calls) to do unconditionally, and it
 * never overrides a variable the shell already set.
 */
export async function ensureEnvLoaded() {
  if (envLoaded) return;
  envLoaded = true;

  const entry = coreEntry();
  if (!entry) return;

  const envLoader = path.resolve(path.dirname(entry), "..", "config", "env.mjs");
  if (!fs.existsSync(envLoader)) return;

  // config/env.mjs announces each file it loads on stdout. That would corrupt
  // `--json`, and it is noise on every single command otherwise — so it is
  // swallowed by default and only surfaced under --debug, where it is genuinely
  // useful ("which .env did it actually read?").
  const prevLog = console.log;
  const debugging = process.env.KODO_DEBUG || process.argv.includes("--debug") || process.argv.includes("--verbose");
  console.log = debugging
    ? (...args) => process.stderr.write(`${args.join(" ")}\n`)
    : () => {};
  try { await import(`file://${envLoader}`); } catch { /* no .env is fine */ }
  finally { console.log = prevLog; }
}

/**
 * Load core. Deliberately async and lazy — `kodo --version`, `kodo config` and
 * `kodo ui stop` must not pay for LangGraph, and must still work if core is
 * missing entirely (a broken install is exactly when `kodo doctor` is needed).
 */
export async function loadCore() {
  if (cached) return cached;

  const entry = coreEntry();
  if (!entry) {
    throw configError(
      "Kodo Core could not be found.",
      "Set KODO_CORE_PATH to the core/index.mjs of your Kodo installation, or run `kodo doctor`.",
    );
  }

  await ensureEnvLoaded();
  cached = await import(`file://${entry}`);
  return cached;
}

/** Core's version, or null when core is not installed. */
export async function coreVersion() {
  try {
    const core = await loadCore();
    return core.VERSION || null;
  } catch {
    return null;
  }
}
