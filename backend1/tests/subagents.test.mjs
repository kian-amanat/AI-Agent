/**
 * tests/subagents.test.mjs
 * Run with: node tests/subagents.test.mjs
 *
 * Declarative subagents: registry loading, frontmatter validation, and — the
 * part that matters — the permission composition that makes widening
 * structurally impossible.
 *
 * Spawn behaviour is exercised through the REAL executeTool("spawn_agent")
 * path, with an unreachable model so the subagent fails fast: what is under
 * test is resolution, gating and lifecycle, not model output.
 */

import assert from "assert";
import { HostRuntime } from "../core/runtime/host.mjs";
import path from "path";
import fs from "fs/promises";
import os from "os";

import {
  loadSubagentRegistry, parseAgentDefinition, composeSubagentTools,
  resolveSubagentModel, describeAgents, BUILTIN_EXPLORER,
  SUBAGENT_BASE_READONLY_TOOLS, SUBAGENT_WRITE_TOOLS,
} from "../services/subagentRegistry.mjs";
import { executeTool } from "../agents/nodes/agent_loop.mjs";
import { normalizeHookConfig, fireHookEvent } from "../services/hooks.mjs";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

const ALL_TOOLS = new Set([...SUBAGENT_BASE_READONLY_TOOLS, ...SUBAGENT_WRITE_TOOLS]);

async function workspaceWith(files) {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-agents-"));
  const dir = path.join(ws, ".kodo", "agents");
  await fs.mkdir(dir, { recursive: true });
  for (const [file, body] of Object.entries(files)) await fs.writeFile(path.join(dir, file), body);
  return ws;
}

const AGENT = (fm, body = "You are a specialised agent. Do the thing.") => `---\n${fm}\n---\n${body}`;

console.log("\n📦 frontmatter parsing + validation");

await test("a valid definition parses, body becomes the prompt", () => {
  const r = parseAgentDefinition(AGENT("name: reviewer\ndescription: Reviews diffs\ntools: [read_file, grep]\nmaxTurns: 15", "Review carefully."), "a.md");
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.definition.name, "reviewer");
  assert.deepStrictEqual(r.definition.tools, ["read_file", "grep"]);
  assert.strictEqual(r.definition.maxTurns, 15);
  assert.strictEqual(r.definition.prompt, "Review carefully.");
  assert.strictEqual(r.definition.writeCapable, false, "read-only must be the default");
});

await test("YAML list form is supported", () => {
  const r = parseAgentDefinition(AGENT("name: a\ndescription: d\ntools:\n  - read_file\n  - glob"));
  assert.deepStrictEqual(r.definition.tools, ["read_file", "glob"]);
});

await test("missing frontmatter is rejected", () => {
  const r = parseAgentDefinition("just a markdown file", "x.md");
  assert.strictEqual(r.ok, false);
  assert.ok(/missing YAML frontmatter/.test(r.error));
});

await test("missing name / description / body are each rejected", () => {
  assert.ok(/"name" is required/.test(parseAgentDefinition(AGENT("description: d")).error));
  assert.ok(/"description" is required/.test(parseAgentDefinition(AGENT("name: a")).error));
  assert.ok(/body .* is required/.test(parseAgentDefinition(AGENT("name: a\ndescription: d", "")).error));
});

await test("an invalid name is rejected", () => {
  assert.ok(/invalid name/.test(parseAgentDefinition(AGENT("name: bad name!\ndescription: d")).error));
});

await test("invalid permissionMode / isolation are rejected", () => {
  assert.ok(/invalid permissionMode/.test(parseAgentDefinition(AGENT("name: a\ndescription: d\npermissionMode: root")).error));
  assert.ok(/invalid isolation/.test(parseAgentDefinition(AGENT("name: a\ndescription: d\nisolation: vm")).error));
});

await test("requesting write tools WITHOUT writeCapable is rejected", () => {
  const r = parseAgentDefinition(AGENT("name: fixer\ndescription: d\ntools: [read_file, write_file]"), "f.md");
  assert.strictEqual(r.ok, false);
  assert.ok(/writeCapable: true/.test(r.error), "the opt-in must be explicit");
});

await test("writeCapable with permissionMode plan is rejected as contradictory", () => {
  const r = parseAgentDefinition(AGENT("name: f\ndescription: d\nwriteCapable: true\npermissionMode: plan"));
  assert.strictEqual(r.ok, false);
  assert.ok(/conflicts with permissionMode/.test(r.error));
});

await test("maxTurns is clamped to a sane ceiling", () => {
  assert.strictEqual(parseAgentDefinition(AGENT("name: a\ndescription: d\nmaxTurns: 9999")).definition.maxTurns, 40);
  assert.strictEqual(parseAgentDefinition(AGENT("name: a\ndescription: d\nmaxTurns: -5")).definition.maxTurns, 12);
});

console.log("\n📦 registry loading");

await test("built-in explorer is always present", async () => {
  const { agents } = await loadSubagentRegistry(null);
  assert.ok(agents.has("explorer"));
  assert.strictEqual(agents.get("explorer").builtin, true);
});

await test("custom agents coexist with built-ins", async () => {
  const ws = await workspaceWith({ "reviewer.md": AGENT("name: reviewer\ndescription: Reviews diffs") });
  const { agents, errors } = await loadSubagentRegistry(ws);
  assert.deepStrictEqual(errors, []);
  assert.ok(agents.has("explorer") && agents.has("reviewer"));
  await fs.rm(ws, { recursive: true, force: true });
});

await test("a custom agent may NOT shadow a built-in name", async () => {
  const ws = await workspaceWith({ "explorer.md": AGENT("name: explorer\ndescription: hijack") });
  const { agents, errors } = await loadSubagentRegistry(ws);
  assert.strictEqual(agents.get("explorer").builtin, true, "the built-in must survive");
  assert.ok(errors.some((e) => /cannot be redefined/.test(e)));
  await fs.rm(ws, { recursive: true, force: true });
});

await test("duplicate custom names are rejected, first wins", async () => {
  const ws = await workspaceWith({
    "a.md": AGENT("name: dup\ndescription: first"),
    "b.md": AGENT("name: dup\ndescription: second"),
  });
  const { agents, errors } = await loadSubagentRegistry(ws);
  assert.strictEqual(agents.get("dup").description, "first", "deterministic: sorted filename order");
  assert.ok(errors.some((e) => /duplicate agent name/.test(e)));
  await fs.rm(ws, { recursive: true, force: true });
});

await test("one malformed file does not prevent valid ones loading", async () => {
  const ws = await workspaceWith({
    "good.md": AGENT("name: good\ndescription: fine"),
    "bad.md": "no frontmatter here",
  });
  const { agents, errors } = await loadSubagentRegistry(ws);
  assert.ok(agents.has("good"), "a bad sibling must not disable a valid agent");
  assert.strictEqual(errors.length, 1);
  await fs.rm(ws, { recursive: true, force: true });
});

await test("loading is deterministic across repeated calls", async () => {
  const ws = await workspaceWith({ "z.md": AGENT("name: z\ndescription: d"), "a.md": AGENT("name: a\ndescription: d") });
  const one = [...(await loadSubagentRegistry(ws)).agents.keys()];
  const two = [...(await loadSubagentRegistry(ws)).agents.keys()];
  assert.deepStrictEqual(one, two);
  await fs.rm(ws, { recursive: true, force: true });
});

await test("no .kodo/agents dir is normal, not an error", async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-noagents-"));
  const { agents, errors } = await loadSubagentRegistry(ws);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(agents.size, 1);
  await fs.rm(ws, { recursive: true, force: true });
});

console.log("\n📦 permission composition (cannot widen)");

await test("default explorer gets the read-only base set", () => {
  const { effective } = composeSubagentTools(BUILTIN_EXPLORER, ALL_TOOLS);
  assert.deepStrictEqual(effective, [...SUBAGENT_BASE_READONLY_TOOLS].sort());
  assert.ok(!effective.includes("write_file"));
});

await test("a definition NARROWS the set", () => {
  const def = parseAgentDefinition(AGENT("name: a\ndescription: d\ntools: [read_file, grep]")).definition;
  assert.deepStrictEqual(composeSubagentTools(def, ALL_TOOLS).effective, ["grep", "read_file"]);
});

await test("a tool the PARENT lacks cannot be added", () => {
  const def = parseAgentDefinition(AGENT("name: a\ndescription: d\ntools: [read_file, bash]")).definition;
  const parent = new Set(["read_file"]); // parent has no bash this run
  const { effective, refused } = composeSubagentTools(def, parent);
  assert.deepStrictEqual(effective, ["read_file"]);
  assert.ok(refused.some((r) => r.name === "bash" && /parent does not have/.test(r.why)));
});

await test("write tools are refused without the opt-in even if the parent has them", () => {
  const def = { ...BUILTIN_EXPLORER, tools: ["read_file", "write_file"], writeCapable: false };
  const { effective, refused } = composeSubagentTools(def, ALL_TOOLS);
  assert.ok(!effective.includes("write_file"));
  assert.ok(refused.some((r) => r.name === "write_file" && /writeCapable/.test(r.why)));
});

await test("with the opt-in, write tools are granted — but still only from the parent", () => {
  const def = parseAgentDefinition(AGENT("name: fixer\ndescription: d\nwriteCapable: true\npermissionMode: auto\ntools: [read_file, write_file]")).definition;
  assert.ok(composeSubagentTools(def, ALL_TOOLS).effective.includes("write_file"), "opt-in should grant it");
  const { effective } = composeSubagentTools(def, new Set(["read_file"]));
  assert.deepStrictEqual(effective, ["read_file"], "a parent without write_file still wins");
});

await test("spawn_agent and ask_user can never be granted to a subagent", () => {
  const def = { ...BUILTIN_EXPLORER, tools: ["read_file", "spawn_agent", "ask_user"], writeCapable: true };
  const { effective, refused } = composeSubagentTools(def, new Set(["read_file", "spawn_agent", "ask_user"]));
  assert.deepStrictEqual(effective, ["read_file"]);
  assert.strictEqual(refused.filter((r) => /never available/.test(r.why)).length, 2);
});

await test("disallowedTools subtracts from the result", () => {
  const def = parseAgentDefinition(AGENT("name: a\ndescription: d\ntools: [read_file, grep, glob]\ndisallowedTools: [grep]")).definition;
  assert.deepStrictEqual(composeSubagentTools(def, ALL_TOOLS).effective, ["glob", "read_file"]);
});

await test("composition is deterministic", () => {
  const def = parseAgentDefinition(AGENT("name: a\ndescription: d\ntools: [glob, read_file, grep]")).definition;
  const a = composeSubagentTools(def, ALL_TOOLS).effective;
  const b = composeSubagentTools(def, ALL_TOOLS).effective;
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(a, [...a].sort());
});

console.log("\n📦 model override policy");

await test("no model declared → inherit the parent's", () => {
  const r = resolveSubagentModel(BUILTIN_EXPLORER, "parent-model", { allow: [] });
  assert.deepStrictEqual(r, { model: "parent-model", overridden: false });
});

await test("a declared model is REFUSED without an explicit allow rule", () => {
  const def = { ...BUILTIN_EXPLORER, model: "big-expensive-model" };
  const r = resolveSubagentModel(def, "parent-model", { allow: [] });
  assert.strictEqual(r.model, "parent-model", "must not silently escalate");
  assert.strictEqual(r.overridden, false);
  assert.strictEqual(r.refused, "big-expensive-model");
});

await test("a wildcard allow rule permits the override", () => {
  const def = { ...BUILTIN_EXPLORER, model: "sonnet" };
  const r = resolveSubagentModel(def, "parent", { allow: ["Subagent(model:*)"] });
  assert.deepStrictEqual(r, { model: "sonnet", overridden: true });
});

await test("a specific allow rule permits only that model", () => {
  const perms = { allow: ["Subagent(model:sonnet)"] };
  assert.strictEqual(resolveSubagentModel({ ...BUILTIN_EXPLORER, model: "sonnet" }, "p", perms).overridden, true);
  assert.strictEqual(resolveSubagentModel({ ...BUILTIN_EXPLORER, model: "opus" }, "p", perms).overridden, false);
});

console.log("\n📦 real spawn path");

const DEAD_CREDS = { apiKey: "x", baseURL: "http://127.0.0.1:1/v1", model: "parent-model" };

function spawnCtx(workspacePath, { permissions = { allow: [], ask: [], deny: [] }, validToolNames = ALL_TOOLS, isSubAgent = false } = {}) {
  const fired = [];
  return {
    ctx: {
      root: workspacePath, emit: null, sessionId: "parent-s", requestId: "parent-r",
      runtime: new HostRuntime({ root: workspacePath }),
      hooks: {}, permissions, editedFiles: new Map(), readFiles: new Set(),
      todosRef: { current: [] }, workspaceSnapshot: [], permissionMode: "auto",
      mcpClients: new Map(), mcpRoutes: new Map(), creds: DEAD_CREDS,
      isSubAgent, validToolNames,
      fireHook: async (event, payload, opts = {}) => {
        fired.push({ event, payload });
        return fireHookEvent(event, payload, { config: normalizeHookConfig({}).hooks, cwd: workspacePath, ...opts });
      },
    },
    fired,
  };
}

await test("omitting agent_type preserves the default explorer path exactly", async () => {
  const ws = await workspaceWith({});
  const { ctx, fired } = spawnCtx(ws);
  const r = await executeTool("spawn_agent", { description: "d", prompt: "investigate" }, ctx);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.agent_type, "explorer");
  assert.deepStrictEqual(r.tools_used, [...SUBAGENT_BASE_READONLY_TOOLS].sort());
  assert.strictEqual(fired.find((e) => e.event === "SubagentStart").payload.subagent_type, "explorer");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("an explicit custom agent_type resolves and reports its real type to hooks", async () => {
  const ws = await workspaceWith({ "reviewer.md": AGENT("name: reviewer\ndescription: Reviews diffs\ntools: [read_file, grep]\nmaxTurns: 7") });
  const { ctx, fired } = spawnCtx(ws);
  const r = await executeTool("spawn_agent", { agent_type: "reviewer", prompt: "review it" }, ctx);
  assert.strictEqual(r.agent_type, "reviewer");
  assert.deepStrictEqual(r.tools_used, ["grep", "read_file"], "the definition's narrower set applies");

  const start = fired.find((e) => e.event === "SubagentStart").payload;
  assert.strictEqual(start.subagent_type, "reviewer", "hooks must see the REAL type, not a hardcoded one");
  assert.strictEqual(start.read_only, true);
  assert.strictEqual(start.max_turns, 7, "the definition's budget must be reported");
  assert.strictEqual(start.parent_session_id, "parent-s");

  const stop = fired.find((e) => e.event === "SubagentStop").payload;
  assert.strictEqual(stop.subagent_type, "reviewer");
  assert.strictEqual(stop.subagent_id, start.subagent_id, "start/stop must correlate");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("an unknown agent_type fails clearly and spawns nothing", async () => {
  const ws = await workspaceWith({});
  const { ctx, fired } = spawnCtx(ws);
  const r = await executeTool("spawn_agent", { agent_type: "ghost", prompt: "x" }, ctx);
  assert.strictEqual(r.success, false);
  assert.ok(/Unknown agent_type "ghost"/.test(r.error));
  assert.ok(/explorer/.test(r.error), "must list what IS available");
  assert.strictEqual(fired.length, 0, "no lifecycle events for an agent that never ran");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("a malformed definition does not become spawnable", async () => {
  const ws = await workspaceWith({ "broken.md": "name: broken\nno frontmatter markers" });
  const { ctx } = spawnCtx(ws);
  const r = await executeTool("spawn_agent", { agent_type: "broken", prompt: "x" }, ctx);
  assert.strictEqual(r.success, false);
  assert.ok(/Unknown agent_type/.test(r.error));
  await fs.rm(ws, { recursive: true, force: true });
});

await test("a subagent's tools cannot exceed the PARENT's at spawn time", async () => {
  const ws = await workspaceWith({ "wide.md": AGENT("name: wide\ndescription: d\ntools: [read_file, bash, glob]") });
  // This run only offered read_file + glob to the parent.
  const { ctx } = spawnCtx(ws, { validToolNames: new Set(["read_file", "glob"]) });
  const r = await executeTool("spawn_agent", { agent_type: "wide", prompt: "x" }, ctx);
  assert.strictEqual(r.success, true);
  assert.deepStrictEqual(r.tools_used, ["glob", "read_file"], "bash must be dropped — the parent didn't have it");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("an agent left with no usable tools fails safely instead of running blind", async () => {
  const ws = await workspaceWith({ "narrow.md": AGENT("name: narrow\ndescription: d\ntools: [bash]") });
  const { ctx } = spawnCtx(ws, { validToolNames: new Set(["read_file"]) });
  const r = await executeTool("spawn_agent", { agent_type: "narrow", prompt: "x" }, ctx);
  assert.strictEqual(r.success, false);
  assert.ok(/no usable tools/.test(r.error));
  await fs.rm(ws, { recursive: true, force: true });
});

await test("a write-capable agent is granted write tools only with the opt-in AND parent grant", async () => {
  const ws = await workspaceWith({ "fixer.md": AGENT("name: fixer\ndescription: d\nwriteCapable: true\npermissionMode: auto\ntools: [read_file, edit_file]") });
  const { ctx, fired } = spawnCtx(ws);
  const r = await executeTool("spawn_agent", { agent_type: "fixer", prompt: "fix" }, ctx);
  assert.ok(r.tools_used.includes("edit_file"));
  assert.strictEqual(fired.find((e) => e.event === "SubagentStart").payload.read_only, false);
  await fs.rm(ws, { recursive: true, force: true });
});

await test("model override is refused at spawn without an allow rule", async () => {
  const ws = await workspaceWith({ "big.md": AGENT("name: big\ndescription: d\nmodel: expensive-model") });
  const { ctx } = spawnCtx(ws);
  const r = await executeTool("spawn_agent", { agent_type: "big", prompt: "x" }, ctx);
  assert.strictEqual(r.model, "parent-model", "must not escalate the model");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("model override applies at spawn when explicitly allowed", async () => {
  const ws = await workspaceWith({ "big.md": AGENT("name: big\ndescription: d\nmodel: expensive-model") });
  const { ctx } = spawnCtx(ws, { permissions: { allow: ["Subagent(model:*)"], ask: [], deny: [] } });
  const r = await executeTool("spawn_agent", { agent_type: "big", prompt: "x" }, ctx);
  assert.strictEqual(r.model, "expensive-model");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("nested spawn is still capped, and fires no lifecycle events", async () => {
  const ws = await workspaceWith({ "reviewer.md": AGENT("name: reviewer\ndescription: d") });
  const { ctx, fired } = spawnCtx(ws, { isSubAgent: true });
  const r = await executeTool("spawn_agent", { agent_type: "reviewer", prompt: "x" }, ctx);
  assert.strictEqual(r.success, false);
  assert.ok(/cannot spawn further sub-agents/.test(r.error));
  assert.strictEqual(fired.length, 0);
  await fs.rm(ws, { recursive: true, force: true });
});

await test("a subagent does not mutate parent conversation state", async () => {
  const ws = await workspaceWith({ "reviewer.md": AGENT("name: reviewer\ndescription: d") });
  const { ctx } = spawnCtx(ws);
  ctx.editedFiles.set("parent.ts", "edit");
  ctx.readFiles.add("parent.ts");
  await executeTool("spawn_agent", { agent_type: "reviewer", prompt: "x" }, ctx);
  assert.deepStrictEqual([...ctx.editedFiles.keys()], ["parent.ts"]);
  assert.deepStrictEqual([...ctx.readFiles], ["parent.ts"]);
  await fs.rm(ws, { recursive: true, force: true });
});

console.log("\n📦 /agents inspector");

await test("describeAgents lists built-ins and customs without leaking prompts", async () => {
  const ws = await workspaceWith({ "reviewer.md": AGENT("name: reviewer\ndescription: Reviews diffs\ntools: [read_file]", "SECRET PROMPT BODY") });
  const { agents } = await loadSubagentRegistry(ws);
  const rows = describeAgents(agents, ALL_TOOLS);
  assert.strictEqual(rows[0].name, "explorer", "built-ins listed first, deterministically");
  const reviewer = rows.find((r) => r.name === "reviewer");
  assert.strictEqual(reviewer.readOnly, true);
  assert.deepStrictEqual(reviewer.effectiveTools, ["read_file"]);
  assert.ok(!JSON.stringify(rows).includes("SECRET PROMPT BODY"), "prompt bodies must never be exposed");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("invalid agents are not listed as valid", async () => {
  const ws = await workspaceWith({ "bad.md": "garbage" });
  const { agents, errors } = await loadSubagentRegistry(ws);
  assert.strictEqual(describeAgents(agents, ALL_TOOLS).length, 1, "only the built-in");
  assert.strictEqual(errors.length, 1, "but the failure is reportable");
  await fs.rm(ws, { recursive: true, force: true });
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
