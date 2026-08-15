/**
 * src/config.mjs — resolved configuration, and the rule that secrets never print.
 *
 * Precedence, highest first:
 *
 *   CLI arguments            --model, --permission, --cwd
 *   project configuration    {workspace}/.kodo/settings.json  ("kodo" block)
 *   user configuration       ~/.kodo/config.json
 *   environment              OPENAI_API_KEY, OPENAI_BASE_URL, DEFAULT_MODEL …
 *   defaults
 *
 * The environment sits BELOW the config files on purpose. A shell that happens
 * to export OPENAI_API_KEY (a leftover from some other tool, or a CI secret
 * injected for a different job) must not silently outrank the key the user
 * deliberately saved with `kodo config set` — that is how a run ends up billed
 * to the wrong account with nothing in the output saying so. The environment is
 * a fallback for machines with no config, which is exactly the Docker case.
 *
 * Every value that could be a credential is funnelled through `redact()` before
 * it can reach a terminal, a log file, or a JSON event.
 */

import { existsSync } from "fs";
import { readJson, userConfigPath, writeJsonAtomic, projectSettingsPath } from "./paths.mjs";
import { configError } from "./exit.mjs";

/**
 * Keys whose values are never printed. Matched case-insensitively against the
 * whole dotted path, as a substring — so `textApiKey`, `mcpServers.x.env.TOKEN`
 * and `oauth.clientSecret` are all caught without having to enumerate them.
 */
const SECRET_PATTERNS = [
  "apikey", "api_key", "key", "token", "secret", "password", "passwd",
  "credential", "authorization", "auth", "bearer", "cookie", "session_token",
];

export function isSecretKey(keyPath) {
  const k = String(keyPath).toLowerCase();
  // "keychain"/"keyboard"-style false positives are not worth special-casing:
  // over-redacting a config value is harmless, under-redacting is not.
  return SECRET_PATTERNS.some((p) => k.includes(p));
}

/** `sk-abc…wxyz` → `sk-…yz` — enough to tell two keys apart, not enough to use. */
export function maskSecret(value) {
  const s = String(value ?? "");
  if (!s) return "(not set)";
  if (s.length <= 8) return "••••••••";
  return `${s.slice(0, 3)}${"•".repeat(8)}${s.slice(-2)}`;
}

/**
 * Deep-copy a value with every secret replaced by a mask. Use this on anything
 * headed for output. It is the only sanctioned way config reaches a user.
 */
export function redact(value, keyPath = "") {
  if (Array.isArray(value)) return value.map((v, i) => redact(v, `${keyPath}[${i}]`));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSecretKey(k) && typeof v !== "object" ? maskSecret(v) : redact(v, keyPath ? `${keyPath}.${k}` : k);
    }
    return out;
  }
  if (isSecretKey(keyPath) && value !== undefined && value !== null) return maskSecret(value);
  return value;
}

export const DEFAULTS = {
  model: "",
  provider: "",
  baseUrl: "",
  permission: "auto",
  ui: { port: 4173, host: "127.0.0.1" },
  server: { port: 9000, host: "127.0.0.1" },
};

function fromEnv() {
  const env = {};
  if (process.env.DEFAULT_MODEL)     env.model   = process.env.DEFAULT_MODEL;
  if (process.env.OPENAI_BASE_URL)   env.baseUrl = process.env.OPENAI_BASE_URL;
  if (process.env.OPENAI_API_KEY)    env.apiKey  = process.env.OPENAI_API_KEY;
  if (process.env.KODO_PERMISSION)   env.permission = process.env.KODO_PERMISSION;
  return env;
}

function merge(base, layer) {
  if (!layer || typeof layer !== "object") return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(layer)) {
    if (v === undefined || v === null || v === "") continue;
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? merge(out[k] || {}, v) : v;
  }
  return out;
}

// A sentinel, not `undefined`: readJson's fallback parameter has a default, so
// passing undefined would silently select `null` and make "no config file yet"
// indistinguishable from "config file is corrupt".
const MISSING = Symbol("missing");

export function loadUserConfig() {
  const file = userConfigPath();
  if (!existsSync(file)) return {};
  const raw = readJson(file, MISSING);
  if (raw === MISSING || raw === null || typeof raw !== "object") {
    throw configError(`${file} is not valid JSON.`, "Fix or delete it, then re-run.");
  }
  return raw;
}

/** The `kodo` block of a project's `.kodo/settings.json`, if it has one. */
export function loadProjectConfig(workspace) {
  if (!workspace) return {};
  const raw = readJson(projectSettingsPath(workspace), null);
  return (raw && typeof raw.kodo === "object" && raw.kodo) || {};
}

/**
 * @param {{workspace?: string, cliFlags?: object}} options
 * @returns {{config: object, sources: Record<string,string>}}
 */
export function resolveConfig({ workspace = "", cliFlags = {} } = {}) {
  const layers = [
    ["defaults",    DEFAULTS],
    ["environment", fromEnv()],
    ["user",        loadUserConfig()],
    ["project",     loadProjectConfig(workspace)],
    ["arguments",   stripUndefined(cliFlags)],
  ];

  let config = {};
  const sources = {};
  for (const [name, layer] of layers) {
    for (const key of Object.keys(layer || {})) sources[key] = name;
    config = merge(config, layer);
  }
  return { config, sources };
}

function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined) out[k] = v;
  return out;
}

// ── kodo config get / set / list ─────────────────────────────────────────────

export function getPath(obj, dotted) {
  return String(dotted).split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

export function setPath(obj, dotted, value) {
  const keys = String(dotted).split(".");
  const last = keys.pop();
  let cursor = obj;
  for (const k of keys) {
    if (typeof cursor[k] !== "object" || cursor[k] === null) cursor[k] = {};
    cursor = cursor[k];
  }
  cursor[last] = value;
  return obj;
}

/** Coerce a command-line string into the type the key expects. */
export function coerceValue(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (raw !== "" && !Number.isNaN(Number(raw)) && /^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

export function saveUserConfig(config) {
  return writeJsonAtomic(userConfigPath(), config, { mode: 0o600 });
}

/** Flatten to `a.b.c = value` lines, redacted. For `kodo config list`. */
export function flatten(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    const keyPath = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, keyPath, out);
    else out.push([keyPath, isSecretKey(k) || isSecretKey(keyPath) ? maskSecret(v) : v]);
  }
  return out;
}
