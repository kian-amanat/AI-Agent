/**
 * services/subagentRegistry.mjs
 *
 * Declarative, file-based subagents — Claude Code's `.claude/agents/*.md`
 * pattern, as `.kodo/agents/*.md`.
 *
 *   ---
 *   name: reviewer
 *   description: Reviews a diff for correctness bugs
 *   tools: [read_file, grep, glob]
 *   model: sonnet
 *   maxTurns: 15
 *   ---
 *   You are a code reviewer. Report only defects you can point at...
 *
 * The markdown body IS the subagent's system prompt.
 *
 * SECURITY MODEL — the whole point of this file:
 *
 *   effective = (parent_allowed ∩ agent_requested) − disallowed − deny_rules
 *
 * A definition can only ever NARROW what the parent already holds. There is no
 * code path by which a frontmatter field grants a tool, a permission, or a
 * capability the spawning context did not already have. Read-only is the floor;
 * write access requires an explicit, auditable opt-in AND must still be within
 * the parent's own grant.
 *
 * Loading is pure: it validates into a fresh Map and only returns on success,
 * so a malformed file can never leave the runtime half-configured.
 */

import path from "path";
import { promises as fs } from "fs";

// Tools a subagent may EVER use, before any narrowing. This is the ceiling for
// the read-only default: no mutation, no user interaction, no nesting.
export const SUBAGENT_BASE_READONLY_TOOLS = [
  "read_file", "grep", "glob", "list_files", "bash",
  "list_memory_topics", "read_memory_topic", "web_search", "fetch_url",
];

// Additional tools unlocked ONLY by an explicit write opt-in.
export const SUBAGENT_WRITE_TOOLS = ["write_file", "edit_file"];

// Never available to a subagent at any permission level:
//   spawn_agent → depth cap; ask_user → subagents don't own the user's attention.
export const SUBAGENT_FORBIDDEN_TOOLS = new Set(["spawn_agent", "ask_user"]);

const DEFAULT_MAX_TURNS = 12;
const MAX_ALLOWED_TURNS = 40;

// The built-in explorer — byte-for-byte the behaviour that existed before this
// registry, so an unspecified agent_type keeps working exactly as it did.
export const BUILTIN_EXPLORER = Object.freeze({
  name: "explorer",
  description: "Read-only investigator. Explores the codebase and reports findings.",
  tools: [...SUBAGENT_BASE_READONLY_TOOLS],
  disallowedTools: [],
  model: null,            // inherit the parent's model
  permissionMode: "plan", // read-only
  maxTurns: DEFAULT_MAX_TURNS,
  skills: [],
  background: false,
  isolation: "none",
  color: null,
  initialPrompt: "",
  writeCapable: false,
  builtin: true,
  source: "(built-in)",
  prompt: `You are a focused sub-agent spawned by Kodo's main coding agent to investigate one thing and report back.

- You are READ-ONLY: read files, grep, glob, list, run read-only shell commands, search the web. You CANNOT edit files or change anything — don't try.
- You do NOT see the main conversation. Work only from the task you were given.
- Be efficient: gather exactly what the task asks for, then STOP.
- Finish with a plain-text report (no tool calls): concrete findings — file paths with line numbers, the specific answer, and anything the main agent needs to act. Lead with the answer, keep it tight. Don't pad.`,
});

// ── Frontmatter parsing ──────────────────────────────────────────────────────

function parseScalar(value) {
  const v = String(value ?? "").trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  return v.replace(/^["']|["']$/g, "");
}

// Accepts `tools: [a, b]` and the YAML list form:
//   tools:
//     - a
//     - b
function parseList(block, key) {
  const inline = block.match(new RegExp(`^${key}:\\s*\\[(.*?)\\]\\s*$`, "m"));
  if (inline) {
    return inline[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }
  const multi = block.match(new RegExp(`^${key}:\\s*\\n((?:\\s*-\\s*.+\\n?)+)`, "m"));
  if (multi) {
    return multi[1].split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }
  const scalar = block.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (scalar && scalar[1].trim()) {
    // A bare comma-separated string is a common hand-written shape.
    return scalar[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }
  return null;
}

/**
 * Parse one agent file. Returns { ok, definition } or { ok:false, error }.
 * Never throws — a bad file must be reportable, not fatal.
 */
export function parseAgentDefinition(raw, source = "(unknown)") {
  const text = String(raw ?? "");
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!fm) return { ok: false, error: `${source}: missing YAML frontmatter (--- … ---)` };

  const block = fm[1];
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  const get = (key) => {
    const m = block.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
    return m ? parseScalar(m[1]) : undefined;
  };

  const name = String(get("name") ?? "").trim();
  if (!name) return { ok: false, error: `${source}: "name" is required` };
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
    return { ok: false, error: `${source}: invalid name "${name}" — use letters, digits, dash, underscore` };
  }
  const description = String(get("description") ?? "").trim();
  if (!description) return { ok: false, error: `${source}: "description" is required` };
  if (!body) return { ok: false, error: `${source}: the markdown body (the agent's prompt) is required` };

  const permissionMode = String(get("permissionMode") ?? "plan").trim();
  if (!["plan", "auto", "ask"].includes(permissionMode)) {
    return { ok: false, error: `${source}: invalid permissionMode "${permissionMode}" (plan | auto | ask)` };
  }

  // WRITE OPT-IN. Two independent, explicit signals are required — a stray
  // permissionMode alone must never silently produce a write-capable agent.
  const writeOptIn = get("writeCapable") === true;
  const requested = parseList(block, "tools");
  const wantsWriteTool = Array.isArray(requested) && requested.some((t) => SUBAGENT_WRITE_TOOLS.includes(t));
  if (wantsWriteTool && !writeOptIn) {
    return { ok: false, error: `${source}: requests write tools (${SUBAGENT_WRITE_TOOLS.join(", ")}) but is missing "writeCapable: true" — write access must be opted into explicitly` };
  }
  if (writeOptIn && permissionMode === "plan") {
    return { ok: false, error: `${source}: "writeCapable: true" conflicts with permissionMode "plan" — set permissionMode to "auto" or "ask"` };
  }

  const rawTurns = get("maxTurns");
  const maxTurns = Number.isFinite(Number(rawTurns)) && Number(rawTurns) > 0
    ? Math.min(Number(rawTurns), MAX_ALLOWED_TURNS)
    : DEFAULT_MAX_TURNS;

  const isolation = String(get("isolation") ?? "none").trim();
  if (!["none", "worktree"].includes(isolation)) {
    return { ok: false, error: `${source}: invalid isolation "${isolation}" (none | worktree)` };
  }

  return {
    ok: true,
    definition: {
      name,
      description,
      // null means "no restriction beyond the base ceiling"
      tools: requested,
      disallowedTools: parseList(block, "disallowedTools") || [],
      model: get("model") ? String(get("model")) : null,
      permissionMode,
      maxTurns,
      skills: parseList(block, "skills") || [],
      background: get("background") === true,
      isolation,
      color: get("color") ? String(get("color")) : null,
      initialPrompt: String(get("initialPrompt") ?? ""),
      writeCapable: writeOptIn,
      builtin: false,
      source,
      prompt: body,
    },
  };
}

// ── Registry loading ─────────────────────────────────────────────────────────

/**
 * Load every agent for a workspace. Built-ins are always present; a custom
 * definition may NOT shadow a built-in name (that would let a workspace
 * silently redefine `explorer` and change default behaviour).
 *
 * Returns { agents: Map, errors: [] }. Errors never prevent the valid agents
 * from loading — one bad file must not disable the rest.
 */
export async function loadSubagentRegistry(workspacePath) {
  const agents = new Map();
  const errors = [];

  for (const builtin of [BUILTIN_EXPLORER]) agents.set(builtin.name, builtin);

  if (!workspacePath) return { agents, errors };

  const dir = path.join(workspacePath, ".kodo", "agents");
  let entries = [];
  try {
    entries = (await fs.readdir(dir)).filter((f) => f.endsWith(".md")).sort(); // sorted → deterministic
  } catch {
    return { agents, errors }; // no agents dir is normal
  }

  const seenCustom = new Set();
  for (const file of entries) {
    const source = path.join(dir, file);
    let raw;
    try { raw = await fs.readFile(source, "utf-8"); }
    catch (err) { errors.push(`${source}: unreadable (${err.message})`); continue; }

    const parsed = parseAgentDefinition(raw, source);
    if (!parsed.ok) { errors.push(parsed.error); continue; }

    const { name } = parsed.definition;
    if (agents.get(name)?.builtin) {
      errors.push(`${source}: "${name}" is a built-in agent name and cannot be redefined`);
      continue;
    }
    if (seenCustom.has(name)) {
      errors.push(`${source}: duplicate agent name "${name}" — names must be unique`);
      continue;
    }
    seenCustom.add(name);
    agents.set(name, parsed.definition);
  }

  return { agents, errors };
}

// ── Permission composition (the security core) ───────────────────────────────

/**
 * effective = (parentAllowed ∩ ceiling ∩ requested) − disallowed − forbidden
 *
 * `parentAllowed` is the tool set the SPAWNING context actually holds. Every
 * term is an intersection or a subtraction — there is no union anywhere, which
 * is what makes widening structurally impossible rather than merely unlikely.
 */
export function composeSubagentTools(definition, parentAllowedToolNames) {
  const parent = parentAllowedToolNames instanceof Set
    ? parentAllowedToolNames
    : new Set(parentAllowedToolNames || []);

  // Ceiling: read-only base, plus write tools only on an explicit opt-in.
  const ceiling = new Set([
    ...SUBAGENT_BASE_READONLY_TOOLS,
    ...(definition.writeCapable ? SUBAGENT_WRITE_TOOLS : []),
  ]);

  // A definition with no `tools:` takes the whole ceiling; otherwise only what
  // it asked for. Either way it is then intersected with the parent's grant.
  const requested = Array.isArray(definition.tools) && definition.tools.length
    ? new Set(definition.tools)
    : ceiling;

  const disallowed = new Set(definition.disallowedTools || []);
  const effective = [];
  const refused = [];

  for (const name of requested) {
    if (SUBAGENT_FORBIDDEN_TOOLS.has(name)) { refused.push({ name, why: "never available to subagents" }); continue; }
    if (!ceiling.has(name)) { refused.push({ name, why: definition.writeCapable ? "not a subagent-capable tool" : "requires writeCapable: true" }); continue; }
    if (disallowed.has(name)) { refused.push({ name, why: "listed in disallowedTools" }); continue; }
    if (!parent.has(name)) { refused.push({ name, why: "the parent does not have this tool" }); continue; }
    effective.push(name);
  }

  // Deterministic order, independent of Set iteration or file ordering.
  effective.sort();
  return { effective, refused };
}

/**
 * Model override policy. A subagent inherits the parent's model unless the
 * workspace explicitly permits overrides — so a definition can never quietly
 * escalate itself onto a more capable (or more expensive) model.
 *
 * Opt in with permissions.allow: ["Subagent(model:*)"] or a specific
 * "Subagent(model:sonnet)".
 */
export function resolveSubagentModel(definition, parentModel, permissions) {
  if (!definition.model) return { model: parentModel, overridden: false };

  const allow = permissions?.allow || [];
  const permitted = allow.some((rule) => {
    const m = String(rule).match(/^Subagent\(model:(.+)\)$/i);
    if (!m) return false;
    const target = m[1].trim();
    return target === "*" || target === definition.model;
  });

  if (!permitted) {
    return { model: parentModel, overridden: false, refused: definition.model };
  }
  return { model: definition.model, overridden: true };
}

/** Flattened view for the /agents inspector. Never exposes prompt bodies. */
export function describeAgents(agents, parentAllowedToolNames = null) {
  return [...agents.values()].map((a) => {
    const composed = parentAllowedToolNames
      ? composeSubagentTools(a, parentAllowedToolNames)
      : { effective: null, refused: [] };
    return {
      name: a.name,
      description: a.description,
      source: a.source,
      builtin: a.builtin,
      readOnly: !a.writeCapable,
      permissionMode: a.permissionMode,
      model: a.model || "(inherits parent)",
      maxTurns: a.maxTurns,
      isolation: a.isolation,
      background: !!a.background,
      declaredTools: Array.isArray(a.tools) ? a.tools : "(all read-only tools)",
      effectiveTools: composed.effective,
      refusedTools: composed.refused,
    };
  }).sort((x, y) => (x.builtin === y.builtin ? x.name.localeCompare(y.name) : x.builtin ? -1 : 1));
}
