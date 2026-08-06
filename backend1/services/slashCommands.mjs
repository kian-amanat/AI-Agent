/**
 * services/slashCommands.mjs
 *
 * Custom slash commands — Claude Code's merged commands/skills model, with
 * project + user scopes, rich frontmatter, validated arguments, templating,
 * composition, versioning, and a cached/watchable registry.
 *
 * A command is a markdown file. All of these produce `/deploy`:
 *
 *   <workspace>/.kodo/commands/deploy.md      (project, highest precedence)
 *   <workspace>/.kodo/skills/deploy/SKILL.md  (project skill)
 *   ~/.kodo/commands/deploy.md                (user/global)
 *   ~/.kodo/skills/deploy.md                  (user skill)
 *
 * Invoking `/deploy staging` EXPANDS the body into the prompt and sends it
 * through the normal pipeline. It is prompt expansion, not a routing engine:
 * nothing here executes tools, grants permissions, or skips a gate. A
 * `permissions:` field is DECLARATIVE ONLY — documentation for the reader and
 * the inspector. It can never widen what the run already holds.
 *
 * FRONTMATTER
 *   description, usage, aliases, examples, hidden, category, permissions,
 *   version, requires, extends, arguments
 *
 * ARGUMENTS
 *   arguments:
 *     - name: env
 *       required: true
 *       enum: [staging, production]
 *     - name: region
 *       default: us-east-1
 *
 * TEMPLATES
 *   {{env}} {{region}}                 — validated argument values
 *   $ARGUMENTS $ARGUMENTS[0] $1        — positional (Claude Code convention)
 *   {{WORKSPACE}} {{DATE}} {{COMMAND}} — built-in variables
 *
 * COMPOSITION
 *   extends: base-command              — prepend another command's body
 *   {{include:other-command}}          — inline another command's body
 *   Both are cycle-detected and depth-capped.
 */

import os from "os";
import path from "path";
import { promises as fs } from "fs";

const MAX_BODY_CHARS = 20_000;
const MAX_COMPOSE_DEPTH = 5;
const CACHE_TTL_MS = 3_000;

// Built-ins live in the route's own switch and may never be shadowed by a file.
export const RESERVED_COMMANDS = new Set([
  "help", "init", "memory", "skills", "hooks", "agents", "mcp", "commands",
]);

export function userCommandRoot() {
  return path.join(os.homedir(), ".kodo");
}

// ── Frontmatter ──────────────────────────────────────────────────────────────

function parseScalar(v) {
  const s = String(v ?? "").trim().replace(/^["']|["']$/g, "");
  if (s === "true") return true;
  if (s === "false") return false;
  return s;
}

function parseInlineList(value) {
  const v = String(value ?? "").trim();
  if (!v) return [];
  const inner = v.startsWith("[") && v.endsWith("]") ? v.slice(1, -1) : v;
  return inner.split(",").map((x) => String(parseScalar(x))).filter(Boolean);
}

function getField(block, key) {
  const m = block.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
  return m ? m[1].trim() : undefined;
}

function getList(block, key) {
  const inline = getField(block, key);
  if (inline) return parseInlineList(inline);
  const multi = block.match(new RegExp(`^${key}:[ \\t]*\\n((?:[ \\t]*-[ \\t]*.+\\n?)+)`, "m"));
  if (!multi) return [];
  return multi[1].split("\n").map((l) => String(parseScalar(l.replace(/^[ \t]*-[ \t]*/, "")))).filter(Boolean);
}

/**
 * Parse an `arguments:` block — the structured list form:
 *
 *   arguments:
 *     - name: env
 *       required: true
 *       enum: [staging, production]
 *       description: Target environment
 */
function parseArgumentSpec(block) {
  // Capture the consecutive INDENTED lines after `arguments:`. A `$` under the
  // /m flag would terminate at the first line end and capture only one line.
  const section = block.match(/^arguments:[ \t]*\n((?:[ \t]+.*(?:\n|$))+)/m);
  if (!section) return [];
  const specs = [];
  let current = null;

  for (const line of section[1].split("\n")) {
    if (!line.trim()) continue;
    const item = line.match(/^[ \t]*-[ \t]*(.*)$/);
    if (item) {
      if (current) specs.push(current);
      current = { name: "", required: false, enum: null, default: null, description: "" };
      const inline = item[1].trim();
      if (inline) {
        const kv = inline.match(/^(\w[\w-]*):[ \t]*(.*)$/);
        if (kv) {
          if (kv[1] === "enum") current.enum = parseInlineList(kv[2]);
          else if (kv[1] === "required") current.required = parseScalar(kv[2]) === true;
          else if (kv[1] in current) current[kv[1]] = String(parseScalar(kv[2]));
        } else current.name = String(parseScalar(inline));
      }
      continue;
    }
    if (!current) continue;
    const kv = line.match(/^[ \t]+(\w[\w-]*):[ \t]*(.*)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    if (key === "enum") current.enum = parseInlineList(rawValue);
    else if (key === "required") current.required = parseScalar(rawValue) === true;
    else if (key === "default") current.default = String(parseScalar(rawValue));
    else if (key === "name") current.name = String(parseScalar(rawValue));
    else if (key === "description") current.description = String(parseScalar(rawValue));
  }
  if (current) specs.push(current);
  return specs.filter((s) => s.name);
}

export function parseCommandFile(raw) {
  const text = String(raw ?? "");
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  const block = fm?.[1] ?? "";

  return {
    name: fm ? String(parseScalar(getField(block, "name") ?? "")) : "",
    description: fm ? String(parseScalar(getField(block, "description") ?? "")) : "",
    usage: fm ? String(parseScalar(getField(block, "usage") ?? "")) : "",
    category: fm ? String(parseScalar(getField(block, "category") ?? "")) : "",
    aliases: fm ? getList(block, "aliases") : [],
    examples: fm ? getList(block, "examples") : [],
    // DECLARATIVE ONLY — surfaced to the reader/inspector, never granted.
    permissions: fm ? getList(block, "permissions") : [],
    hidden: fm ? parseScalar(getField(block, "hidden") ?? "") === true : false,
    version: fm ? String(parseScalar(getField(block, "version") ?? "")) : "",
    requires: fm ? getList(block, "requires") : [],
    extends: fm ? String(parseScalar(getField(block, "extends") ?? "")) : "",
    argumentHint: fm ? String(parseScalar(getField(block, "argument-hint") ?? getField(block, "argumentHint") ?? "")) : "",
    argumentsSpec: fm ? parseArgumentSpec(block) : [],
    // The raw-text fallback is ONLY for files with no frontmatter at all —
    // otherwise a frontmatter-only file would use its own frontmatter as body.
    body: fm ? body : (body || text.trim()),
  };
}

/** Relative file path → command name. Pure, so it is stable across reloads. */
export function commandNameFromPath(relPath, source) {
  const clean = String(relPath).replace(/\\/g, "/").replace(/\.md$/i, "");
  const parts = clean.split("/").filter(Boolean);
  if (source === "skills") {
    if (parts[parts.length - 1].toUpperCase() === "SKILL") parts.pop();
    if (!parts.length) return null;
  }
  return parts.join(":").toLowerCase();
}

async function walkMarkdown(dir, base = dir, out = []) {
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkMarkdown(full, base, out);
    else if (e.name.endsWith(".md") && !e.name.startsWith("_")) out.push({ full, rel: path.relative(base, full) });
  }
  return out;
}

// ── Versioning ───────────────────────────────────────────────────────────────

function parseVersion(v) {
  const m = String(v || "").trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** Minimal range support: exact, >=, >, <=, <, ^ (same major), * / any. */
export function satisfiesVersion(version, range) {
  const r = String(range || "").trim();
  if (!r || r === "*" || r === "any") return true;
  const actual = parseVersion(version);
  if (!actual) return false;

  const m = r.match(/^(\^|>=|<=|>|<|=)?\s*(.+)$/);
  const wanted = parseVersion(m[2]);
  if (!wanted) return false;
  const cmp = compareVersions(actual, wanted);

  switch (m[1]) {
    case ">=": return cmp >= 0;
    case ">": return cmp > 0;
    case "<=": return cmp <= 0;
    case "<": return cmp < 0;
    case "^": return actual[0] === wanted[0] && cmp >= 0;
    default: return cmp === 0;
  }
}

/** `name@^1.2` → { name, range }. A bare name means any version. */
export function parseRequirement(spec) {
  const s = String(spec || "").trim();
  const at = s.lastIndexOf("@");
  if (at <= 0) return { name: s.toLowerCase(), range: "*" };
  return { name: s.slice(0, at).toLowerCase(), range: s.slice(at + 1) };
}

// ── Registry (cached) ────────────────────────────────────────────────────────

const cache = new Map(); // cacheKey → { at, signature, result }

/** Cheap change signature: every command file's path + mtime + size. */
async function directorySignature(dirs) {
  const parts = [];
  for (const dir of dirs) {
    for (const { full } of await walkMarkdown(dir)) {
      try {
        const st = await fs.stat(full);
        parts.push(`${full}:${st.mtimeMs}:${st.size}`);
      } catch { parts.push(`${full}:gone`); }
    }
  }
  return parts.sort().join("|");
}

function sourceDirs(workspacePath, homeDir) {
  const dirs = [];
  // Project sources are scanned FIRST, so a user command can never silently
  // shadow the project's own definition of the same name.
  if (workspacePath) {
    dirs.push({ source: "commands", scope: "project", dir: path.join(workspacePath, ".kodo", "commands") });
    dirs.push({ source: "skills", scope: "project", dir: path.join(workspacePath, ".kodo", "skills") });
  }
  const home = homeDir || userCommandRoot();
  if (home) {
    dirs.push({ source: "commands", scope: "user", dir: path.join(home, "commands") });
    dirs.push({ source: "skills", scope: "user", dir: path.join(home, "skills") });
  }
  return dirs;
}

/**
 * Discover every command visible to a workspace.
 * Returns { commands, aliases, conflicts, errors, cached }.
 */
export async function loadCommandRegistry(workspacePath, { homeDir = null, useCache = true } = {}) {
  const dirs = sourceDirs(workspacePath, homeDir);
  const cacheKey = dirs.map((d) => d.dir).join("|");

  if (useCache) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      // Even inside the TTL, confirm nothing on disk changed — a stale command
      // is worse than a slightly slower lookup.
      if (await directorySignature(dirs.map((d) => d.dir)) === hit.signature) {
        return { ...hit.result, cached: true };
      }
    }
  }

  const commands = new Map();
  const aliases = new Map(); // alias → canonical name
  const conflicts = [];
  const errors = [];

  for (const { source, scope, dir } of dirs) {
    for (const { full, rel } of await walkMarkdown(dir)) {
      const name = commandNameFromPath(rel, source);
      if (!name) continue;

      if (RESERVED_COMMANDS.has(name)) {
        conflicts.push(`${full}: "/${name}" is a built-in command and cannot be overridden`);
        continue;
      }

      let raw;
      try { raw = await fs.readFile(full, "utf-8"); }
      catch (err) { errors.push(`${full}: unreadable (${err.message})`); continue; }

      const parsed = parseCommandFile(raw);
      if (!parsed.body) { errors.push(`${full}: empty command body`); continue; }

      if (commands.has(name)) {
        const winner = commands.get(name);
        conflicts.push(`${full}: "/${name}" already defined by ${winner.scope}/${winner.source} (${winner.file}) — the first definition wins`);
        continue;
      }

      commands.set(name, {
        name,
        description: parsed.description || "(no description)",
        usage: parsed.usage || "",
        category: parsed.category || "general",
        aliases: parsed.aliases,
        examples: parsed.examples,
        declaredPermissions: parsed.permissions, // advisory only
        hidden: parsed.hidden,
        version: parsed.version || "",
        requires: parsed.requires,
        extends: parsed.extends || "",
        argumentHint: parsed.argumentHint,
        argumentsSpec: parsed.argumentsSpec,
        body: parsed.body.slice(0, MAX_BODY_CHARS),
        file: full,
        source,   // "commands" | "skills"
        scope,    // "project" | "user"
        enabled: true,
        disabledReason: null,
      });

      for (const alias of parsed.aliases) {
        const a = alias.toLowerCase();
        if (RESERVED_COMMANDS.has(a)) { conflicts.push(`${full}: alias "/${a}" is a built-in command — ignored`); continue; }
        if (aliases.has(a)) { conflicts.push(`${full}: alias "/${a}" already maps to "/${aliases.get(a)}" — ignored`); continue; }
        aliases.set(a, name);
      }
    }
  }

  // An alias must never shadow a real command name.
  for (const a of [...aliases.keys()]) {
    if (commands.has(a)) {
      conflicts.push(`alias "/${a}" collides with a command of the same name — ignored`);
      aliases.delete(a);
    }
  }

  // Dependencies are validated AFTER the full set is known, so filesystem
  // order never affects the outcome.
  for (const cmd of commands.values()) {
    for (const req of cmd.requires) {
      const { name: depName, range } = parseRequirement(req);
      const dep = commands.get(depName) || commands.get(aliases.get(depName));
      if (!dep) {
        cmd.enabled = false;
        cmd.disabledReason = `requires "/${depName}", which is not installed`;
        errors.push(`${cmd.file}: /${cmd.name} requires "/${depName}" which is not installed — command disabled`);
      } else if (!satisfiesVersion(dep.version, range)) {
        cmd.enabled = false;
        cmd.disabledReason = `requires ${depName}@${range}, found ${dep.version || "(unversioned)"}`;
        errors.push(`${cmd.file}: /${cmd.name} requires ${depName}@${range} but found ${dep.version || "(unversioned)"} — command disabled`);
      }
    }
  }

  const result = { commands, aliases, conflicts, errors, cached: false };
  cache.set(cacheKey, { at: Date.now(), signature: await directorySignature(dirs.map((d) => d.dir)), result });
  return result;
}

export function invalidateCommandCache(workspacePath = null, homeDir = null) {
  if (!workspacePath) { cache.clear(); return true; }
  return cache.delete(sourceDirs(workspacePath, homeDir).map((d) => d.dir).join("|"));
}

export function commandCacheSize() { return cache.size; }

/** Directories a file watcher should observe for live reload. */
export function commandWatchDirs(workspacePath, homeDir = null) {
  return sourceDirs(workspacePath, homeDir).map((d) => d.dir);
}

// ── Invocation ───────────────────────────────────────────────────────────────

export function parseCommandInvocation(message) {
  const m = String(message || "").trim().match(/^\/([a-z0-9][a-z0-9_:-]*)(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (name.startsWith("mcp__")) return null; // MCP prompts have their own handler

  const raw = (m[2] || "").trim();
  const args = [];
  const named = {};
  const re = /(\w[\w-]*)=(?:"([^"]*)"|'([^']*)'|(\S+))|"([^"]*)"|'([^']*)'|(\S+)/g;
  let tok;
  while ((tok = re.exec(raw))) {
    if (tok[1] !== undefined) named[tok[1]] = tok[2] ?? tok[3] ?? tok[4] ?? "";
    else args.push(tok[5] ?? tok[6] ?? tok[7]);
  }
  return { name, args, named, raw };
}

/** Resolve a name or alias to its canonical command. */
export function resolveCommand(name, registry, aliases) {
  const key = String(name || "").toLowerCase();
  return registry.get(key) || registry.get(aliases?.get(key)) || null;
}

// ── Argument validation ──────────────────────────────────────────────────────

/**
 * Validate positional + named arguments against the declared spec.
 * Fails loudly rather than coercing — a wrong `env` on a deploy command is
 * exactly the case that must not slide through.
 */
export function validateArguments(spec, { args = [], named = {} } = {}) {
  const values = {};
  if (!spec?.length) return { ok: true, values };

  for (let i = 0; i < spec.length; i++) {
    const s = spec[i];
    let value = named[s.name] !== undefined ? named[s.name] : args[i];

    if (value === undefined || value === "") {
      if (s.default !== null && s.default !== undefined && s.default !== "") value = s.default;
      else if (s.required) {
        const hint = s.enum?.length ? ` (one of: ${s.enum.join(", ")})` : "";
        return { ok: false, error: `Missing required argument "${s.name}"${hint}.${s.description ? ` ${s.description}` : ""}` };
      } else { values[s.name] = ""; continue; }
    }

    if (s.enum?.length && !s.enum.includes(String(value))) {
      return { ok: false, error: `Invalid value "${value}" for "${s.name}" — must be one of: ${s.enum.join(", ")}.` };
    }
    values[s.name] = String(value);
  }
  return { ok: true, values };
}

// ── Templating ───────────────────────────────────────────────────────────────

export function builtinVariables({ workspacePath, commandName, args, raw }) {
  const now = new Date();
  return {
    WORKSPACE: workspacePath || "",
    WORKSPACE_NAME: workspacePath ? path.basename(workspacePath) : "",
    DATE: now.toISOString().slice(0, 10),
    TIME: now.toISOString().slice(11, 19),
    COMMAND: commandName || "",
    ARGC: String(args?.length ?? 0),
    ARGS_RAW: raw || "",
  };
}

/**
 * Render a command body.
 *
 * Positional tokens are substituted first, then named/built-in variables, so a
 * `$1` appearing inside a substituted value cannot be re-expanded. Unknown
 * `{{tokens}}` are left verbatim — silently deleting text the author wrote is
 * worse than leaving something visibly unresolved.
 */
export function renderTemplate(body, { values = {}, vars = {}, args = [], raw = "" } = {}) {
  const all = raw || args.join(" ");
  const referencesArgs = /\$ARGUMENTS(\[\d+\])?|\$\d+|\{\{\s*\w/.test(body);

  let out = String(body)
    .replace(/\$ARGUMENTS\[(\d+)\]/g, (_, i) => args[Number(i)] ?? "")
    .replace(/\$ARGUMENTS\b/g, all)
    .replace(/\$(\d+)\b/g, (_, i) => args[Number(i) - 1] ?? "");

  const table = { ...vars, ...values };
  out = out.replace(/\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(table, key) ? String(table[key]) : whole);

  if (!referencesArgs && all) out = `${out}\n\nArguments: ${all}`;
  return out;
}

// ── Composition ──────────────────────────────────────────────────────────────

/**
 * Resolve `extends:` and `{{include:name}}` into a single body.
 * Cycle-detected and depth-capped — a self-including command fails with a
 * clear error rather than recursing until the stack dies.
 */
export function composeBody(command, registry, aliases, seen = new Set(), depth = 0) {
  if (depth > MAX_COMPOSE_DEPTH) {
    return { ok: false, error: `Command composition exceeded ${MAX_COMPOSE_DEPTH} levels (possible cycle) at "/${command.name}".` };
  }
  if (seen.has(command.name)) {
    return { ok: false, error: `Circular command composition detected: ${[...seen, command.name].map((n) => `/${n}`).join(" → ")}` };
  }
  seen.add(command.name);

  let body = command.body;

  if (command.extends) {
    const base = resolveCommand(command.extends, registry, aliases);
    if (!base) return { ok: false, error: `"/${command.name}" extends "/${command.extends}", which does not exist.` };
    const composed = composeBody(base, registry, aliases, new Set(seen), depth + 1);
    if (!composed.ok) return composed;
    body = `${composed.body}\n\n${body}`;
  }

  for (const [token, rawName] of [...body.matchAll(/\{\{\s*include:\s*([a-z0-9][\w:-]*)\s*\}\}/gi)]) {
    const target = resolveCommand(rawName, registry, aliases);
    if (!target) return { ok: false, error: `"/${command.name}" includes "/${rawName}", which does not exist.` };
    const composed = composeBody(target, registry, aliases, new Set(seen), depth + 1);
    if (!composed.ok) return composed;
    body = body.split(token).join(composed.body);
  }

  return { ok: true, body };
}

// ── Expansion ────────────────────────────────────────────────────────────────

export function expandCommand(invocation, registry, options = {}) {
  const { aliases = new Map(), workspacePath = "" } = options;
  const command = resolveCommand(invocation.name, registry, aliases);

  if (!command) {
    const available = [...registry.values()].filter((c) => !c.hidden).map((c) => `/${c.name}`).sort().join(", ") || "(none)";
    return { ok: false, error: `Unknown command "/${invocation.name}". Available: ${available}` };
  }
  if (!command.enabled) {
    return { ok: false, error: `"/${command.name}" is disabled: ${command.disabledReason || "unmet requirements"}.` };
  }

  const validated = validateArguments(command.argumentsSpec, invocation);
  if (!validated.ok) {
    const usage = command.usage || `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`;
    return { ok: false, error: `${validated.error}\nUsage: ${usage}` };
  }

  const composed = composeBody(command, registry, aliases);
  if (!composed.ok) return { ok: false, error: composed.error };

  const expanded = renderTemplate(composed.body, {
    values: validated.values,
    vars: builtinVariables({ workspacePath, commandName: command.name, args: invocation.args, raw: invocation.raw }),
    args: invocation.args,
    raw: invocation.raw,
  });

  return { ok: true, command, expanded, values: validated.values };
}

// ── Listing / autocomplete ───────────────────────────────────────────────────

/** Inspector view. Never includes command bodies. */
export function describeCommands(registry, { includeHidden = false } = {}) {
  return [...registry.values()]
    .filter((c) => includeHidden || !c.hidden)
    .map((c) => ({
      name: c.name,
      description: c.description,
      usage: c.usage || `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`,
      category: c.category,
      aliases: c.aliases,
      examples: c.examples,
      scope: c.scope,
      source: c.source,
      file: c.file,
      hidden: c.hidden,
      enabled: c.enabled,
      disabledReason: c.disabledReason,
      version: c.version,
      requires: c.requires,
      declaredPermissions: c.declaredPermissions,
      arguments: c.argumentsSpec.map((a) => ({
        name: a.name, required: a.required, enum: a.enum, default: a.default, description: a.description,
      })),
    }))
    .sort((a, b) => (a.category === b.category ? a.name.localeCompare(b.name) : a.category.localeCompare(b.category)));
}

/**
 * Autocomplete for a partially typed command. Matches names and aliases;
 * hidden commands are excluded unless typed exactly.
 */
export function completeCommand(prefix, registry, aliases = new Map()) {
  const raw = String(prefix || "").replace(/^\//, "").toLowerCase();
  const out = [];

  for (const c of registry.values()) {
    const aliasHit = c.aliases.find((a) => a.toLowerCase().startsWith(raw));
    const nameHit = c.name.startsWith(raw);
    if (!nameHit && !aliasHit) continue;
    if (c.hidden && c.name !== raw) continue;
    out.push({
      name: c.name,
      completion: `/${c.name}`,
      matchedAlias: !nameHit && aliasHit ? aliasHit : null,
      description: c.description,
      usage: c.usage || `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`,
      category: c.category,
      enabled: c.enabled,
      arguments: c.argumentsSpec.map((a) => ({ name: a.name, required: a.required, enum: a.enum })),
    });
  }
  void aliases;
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
