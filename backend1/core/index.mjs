/**
 * core/index.mjs — the one import surface every Kodo client uses.
 *
 * Kodo's agent (graph → router → answer/agent_loop, tools, MCP, skills, memory,
 * permissions, hooks, planning, verification, undo) already lives in
 * backend1/agents and backend1/services and has no editor dependency. What was
 * missing was a NAMED boundary: the CLI, the HTTP server and the VS Code
 * extension each had to reach into internal module paths to find it, which is
 * how three copies of "the agent" start to exist. This file is that boundary.
 *
 * Rules for this module:
 *  1. Importing it MUST NOT require credentials, a database, or a workspace.
 *     `kodo --version` and `kodo doctor` import it on a machine with nothing
 *     configured, and they have to work there.
 *  2. It re-exports; it does not reimplement. Anything with logic in it belongs
 *     in the service it came from.
 *  3. Anything that constructs a provider client, opens the SQLite database, or
 *     spawns a process is exposed through a lazy accessor, never a static
 *     re-export, so rule 1 keeps holding as the agent grows.
 */

import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repository root — the directory that contains backend1/. */
export const CORE_ROOT = path.resolve(__dirname, "..");

/**
 * Single source of truth for the version every surface reports. The CLI, the
 * server's /health, the UI banner and the extension all read this one value, so
 * a mismatch between them is detectable rather than invisible.
 */
export const VERSION = (() => {
  try {
    return createRequire(import.meta.url)("../package.json").version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// ── The agent ────────────────────────────────────────────────────────────────
// Lazy: graph_runner pulls in the full agent loop and the LangGraph runtime,
// which is a real cost to pay for `kodo config get model`.

/**
 * Run one agent turn. This is THE agent — the same function the HTTP route and
 * the benchmark driver call. There is no CLI-specific loop.
 *
 * @see backend1/services/graph_runner.mjs for the full parameter contract.
 */
export async function runAgent(options) {
  const { runKodoGraph } = await import("../services/graph_runner.mjs");
  return runKodoGraph(options);
}

/** Rebuild a tool-loop conversation from persisted turn events (resume). */
export async function conversation() {
  return import("../services/conversationStore.mjs");
}

// ── Project configuration ────────────────────────────────────────────────────

/** Read `{workspace}/.kodo/settings.json` → { hooks, permissions, mcpServers }. */
export async function loadProjectSettings(workspacePath) {
  const { loadKodoSettings } = await import("../agents/nodes/agent_loop.mjs");
  return loadKodoSettings(workspacePath);
}

/** Custom slash commands declared in `.kodo/commands` and `.kodo/skills`. */
export async function loadCommands(workspacePath) {
  const mod = await import("../services/slashCommands.mjs");
  return mod.loadCommandRegistry(workspacePath);
}

/** Subagents declared in `.kodo/agents/*.md`. */
export async function loadSubagents(workspacePath) {
  const mod = await import("../services/subagentRegistry.mjs");
  return mod.loadSubagentRegistry(workspacePath);
}

/** Lifecycle hooks, with the warnings raised while validating them. */
export async function loadHooks(workspacePath) {
  const mod = await import("../services/hooks.mjs");
  return mod.loadHookConfig(workspacePath);
}

/** Expert skill packs available to load (`.kodo/skills/*.md`). */
export async function loadSkills(workspacePath) {
  const { loadSkillIndex } = await import("../agents/nodes/agent_loop.mjs");
  return loadSkillIndex(workspacePath);
}

/** The cross-session memory index (`.kodo/memory/MEMORY.md`). */
export async function loadMemory(workspacePath) {
  const mod = await import("../services/agentMemory.mjs");
  return {
    index: await mod.loadMemoryIndex(workspacePath),
    topics: await mod.listMemoryTopics(workspacePath),
  };
}

// ── MCP ──────────────────────────────────────────────────────────────────────

/**
 * Connect to every configured MCP server and report what actually came up.
 * Deliberately a live probe, not a config listing: "declared but not installed"
 * is the failure people actually hit, and only connecting reveals it.
 */
export async function probeMcpServers(workspacePath) {
  const { mcpServers } = await loadProjectSettings(workspacePath);
  const names = Object.keys(mcpServers || {});
  if (!names.length) return { configured: 0, servers: [] };

  const { discoverMcpTools, isPooledClient } = await import("../services/mcpTools.mjs");
  const clients = new Map();
  try {
    const { servers } = await discoverMcpTools({ mcpServers, cwd: workspacePath, mcpClients: clients });
    return { configured: names.length, servers };
  } finally {
    for (const c of clients.values()) {
      if (!isPooledClient(c)) { try { c.close(); } catch { /* best effort */ } }
    }
  }
}

// ── Project introspection (kodo init) ────────────────────────────────────────

/** Evidence-gathering + validated KODO.md generation, as used by `/init`. */
export async function projectEvidence() {
  return import("../services/projectEvidence.mjs");
}

/** Walk a workspace tree with the agent's own exclusion rules. */
export async function walkWorkspace(workspacePath, depth = 6) {
  const mod = await import("../agents/nodes/agent_loop.mjs");
  return mod.walkWorkspace(workspacePath, depth);
}

/** The LLM call used by non-agent features (KODO.md generation, compaction). */
export async function callModel(options) {
  const { callLLM } = await import("../services/llm.mjs");
  return callLLM(options);
}

// ── Execution runtime ────────────────────────────────────────────────────────
// Every workspace read/write and every process launch a tool performs goes
// through one of these. See core/runtime/contract.mjs for the boundary.

/**
 * Build and start a runtime, verifying isolation when a sandbox was requested.
 * Refuses — never silently falls back to the host — if isolation cannot be
 * proven on this machine.
 */
export async function createRuntime(options) {
  const mod = await import("./runtime/index.mjs");
  return mod.createRuntime(options);
}

/** Which sandboxes this machine can actually provide, probed live. */
export async function availableSandboxes() {
  const mod = await import("./runtime/index.mjs");
  return mod.availableSandboxes();
}

export const SANDBOX_KINDS = ["host", "docker", "incus"];

/**
 * Sandboxes Kodo is willing to PRESENT as supported. Incus is implemented but
 * unverified against a live daemon — see core/runtime/index.mjs.
 */
export async function advertisedSandboxes() {
  const mod = await import("./runtime/index.mjs");
  return mod.advertisedSandboxes();
}

export function isSandboxKind(value) {
  return SANDBOX_KINDS.includes(value);
}

// ── Permissions ──────────────────────────────────────────────────────────────

/**
 * The permission modes the agent understands, unchanged from the HTTP surface.
 * `ask` pauses before the first mutation; `plan` explores without mutating;
 * `auto` proceeds under the workspace's own `.kodo/settings.json` permission
 * rules (which still gate dangerous commands and sensitive files).
 */
export const PERMISSION_MODES = ["auto", "ask", "plan"];

export function isPermissionMode(value) {
  return PERMISSION_MODES.includes(value);
}
