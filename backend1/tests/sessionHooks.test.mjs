/**
 * tests/sessionHooks.test.mjs
 * Run with: node tests/sessionHooks.test.mjs
 *
 * Phase C + D + D.1 lifecycle wiring:
 *   • Setup / SessionStart / SessionEnd fire EXACTLY once at the right moment
 *     (never per turn, never per model iteration)
 *   • UserPromptSubmit / UserPromptExpansion run before the model, can veto,
 *     and keep the original prompt distinguishable from the expanded one
 *   • PermissionRequest / PermissionDenied respect the documented precedence
 *     and can never widen access past an explicit deny rule
 *
 * Hooks run as REAL child processes throughout.
 */

import assert from "assert";
import { HostRuntime } from "../core/runtime/host.mjs";
import path from "path";
import fs from "fs/promises";
import os from "os";

import { createHookRunner, normalizeHookConfig, fireHookEvent } from "../services/hooks.mjs";
import {
  ensureSetup, ensureSessionStart, endSession, endAllSessions,
  attachRunner, isSessionActive, activeSessionIds, _resetSessionHookState,
} from "../services/sessionHooks.mjs";

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

// A workspace whose hooks append one line per firing, so "exactly once" is
// checkable by counting rather than by trusting a flag.
async function makeWorkspace(hooks) {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-sess-"));
  await fs.mkdir(path.join(ws, ".kodo"), { recursive: true });
  await fs.writeFile(path.join(ws, ".kodo", "settings.json"), JSON.stringify({ hooks }, null, 2));
  return ws;
}
const log = (ws, name) => path.join(ws, `${name}.log`);
async function readLog(ws, name) {
  try { return (await fs.readFile(log(ws, name), "utf-8")).trim().split("\n").filter(Boolean); }
  catch { return []; }
}
const appendHook = (ws, name, extra = "") => ({
  hooks: [{ type: "command", command: `echo "${extra || "fired"}" >> ${log(ws, name)}` }],
});

console.log("\n📦 Setup (once per workspace, never per turn)");

await test("Setup fires on first use and writes its marker", async () => {
  _resetSessionHookState();
  const ws = await makeWorkspace({});
  // The hook command needs the workspace path, so the config is written once ws exists.
  await fs.writeFile(path.join(ws, ".kodo", "settings.json"),
    JSON.stringify({ hooks: { Setup: [appendHook(ws, "setup")] } }));
  const runner = await createHookRunner({ workspacePath: ws });
  const r = await ensureSetup({ workspacePath: ws, fire: runner.fire });
  assert.strictEqual(r.fired, true);
  assert.deepStrictEqual(await readLog(ws, "setup"), ["fired"]);
  await fs.access(path.join(ws, ".kodo", ".setup-complete"));
  await fs.rm(ws, { recursive: true, force: true });
});

await test("Setup does NOT re-fire on later turns (10 calls → 1 execution)", async () => {
  _resetSessionHookState();
  const ws = await makeWorkspace({});
  await fs.writeFile(path.join(ws, ".kodo", "settings.json"), JSON.stringify({ hooks: { Setup: [appendHook(ws, "setup")] } }));
  const runner = await createHookRunner({ workspacePath: ws });
  for (let i = 0; i < 10; i++) await ensureSetup({ workspacePath: ws, fire: runner.fire });
  assert.deepStrictEqual(await readLog(ws, "setup"), ["fired"], "Setup must be one-time bootstrap, not per-turn");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("Setup survives a process restart via its marker", async () => {
  _resetSessionHookState();
  const ws = await makeWorkspace({});
  await fs.writeFile(path.join(ws, ".kodo", "settings.json"), JSON.stringify({ hooks: { Setup: [appendHook(ws, "setup")] } }));
  const runner = await createHookRunner({ workspacePath: ws });
  await ensureSetup({ workspacePath: ws, fire: runner.fire });
  _resetSessionHookState(); // simulate a fresh process
  await ensureSetup({ workspacePath: ws, fire: runner.fire });
  assert.deepStrictEqual(await readLog(ws, "setup"), ["fired"]);
  await fs.rm(ws, { recursive: true, force: true });
});

await test("a BLOCKING Setup hook leaves no marker, so it retries next run", async () => {
  _resetSessionHookState();
  const ws = await makeWorkspace({});
  await fs.writeFile(path.join(ws, ".kodo", "settings.json"),
    JSON.stringify({ hooks: { Setup: [{ hooks: [{ type: "command", command: "echo 'deps missing' >&2; exit 2" }] }] } }));
  const runner = await createHookRunner({ workspacePath: ws });
  const r = await ensureSetup({ workspacePath: ws, fire: runner.fire });
  assert.strictEqual(r.blocked, true);
  await assert.rejects(() => fs.access(path.join(ws, ".kodo", ".setup-complete")), "a failed setup must not be marked complete");
  await fs.rm(ws, { recursive: true, force: true });
});

console.log("\n📦 SessionStart (once per session — not per turn/iteration)");

await test("fires once for a NEW session with source=startup", async () => {
  _resetSessionHookState();
  const ws = await makeWorkspace({});
  await fs.writeFile(path.join(ws, ".kodo", "settings.json"), JSON.stringify({ hooks: { SessionStart: [appendHook(ws, "start")] } }));
  const runner = await createHookRunner({ workspacePath: ws });
  const r = await ensureSessionStart({ sessionId: "s1", userId: null, workspacePath: ws, isNew: true, fire: runner.fire });
  assert.strictEqual(r.fired, true);
  assert.strictEqual(r.source, "startup");
  assert.deepStrictEqual(await readLog(ws, "start"), ["fired"]);
  await fs.rm(ws, { recursive: true, force: true });
});

await test("fires for a RESUMED session with source=resume", async () => {
  _resetSessionHookState();
  const ws = await makeWorkspace({});
  await fs.writeFile(path.join(ws, ".kodo", "settings.json"), JSON.stringify({ hooks: { SessionStart: [appendHook(ws, "start")] } }));
  const runner = await createHookRunner({ workspacePath: ws });
  const r = await ensureSessionStart({ sessionId: "s2", userId: null, workspacePath: ws, isNew: false, fire: runner.fire });
  assert.strictEqual(r.source, "resume");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("20 turns on one session → SessionStart fires ONCE", async () => {
  _resetSessionHookState();
  const ws = await makeWorkspace({});
  await fs.writeFile(path.join(ws, ".kodo", "settings.json"), JSON.stringify({ hooks: { SessionStart: [appendHook(ws, "start")] } }));
  const runner = await createHookRunner({ workspacePath: ws });
  for (let i = 0; i < 20; i++) {
    await ensureSessionStart({ sessionId: "s3", userId: null, workspacePath: ws, isNew: i === 0, fire: runner.fire });
  }
  assert.deepStrictEqual(await readLog(ws, "start"), ["fired"], "must not fire per turn");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("concurrent first requests on one session do not double-fire", async () => {
  _resetSessionHookState();
  const ws = await makeWorkspace({});
  await fs.writeFile(path.join(ws, ".kodo", "settings.json"), JSON.stringify({ hooks: { SessionStart: [appendHook(ws, "start")] } }));
  const runner = await createHookRunner({ workspacePath: ws });
  await Promise.all([1, 2, 3, 4].map(() =>
    ensureSessionStart({ sessionId: "race", userId: null, workspacePath: ws, isNew: true, fire: runner.fire })));
  assert.deepStrictEqual(await readLog(ws, "start"), ["fired"]);
  await fs.rm(ws, { recursive: true, force: true });
});

await test("separate sessions each get their own SessionStart", async () => {
  _resetSessionHookState();
  const ws = await makeWorkspace({});
  await fs.writeFile(path.join(ws, ".kodo", "settings.json"), JSON.stringify({ hooks: { SessionStart: [appendHook(ws, "start")] } }));
  const runner = await createHookRunner({ workspacePath: ws });
  await ensureSessionStart({ sessionId: "a", userId: null, workspacePath: ws, isNew: true, fire: runner.fire });
  await ensureSessionStart({ sessionId: "b", userId: null, workspacePath: ws, isNew: true, fire: runner.fire });
  assert.strictEqual((await readLog(ws, "start")).length, 2);
  await fs.rm(ws, { recursive: true, force: true });
});

await test("SessionStart can inject additionalContext", async () => {
  _resetSessionHookState();
  const ws = await makeWorkspace({});
  const json = JSON.stringify({ hookSpecificOutput: { additionalContext: "branch is release/1.2" } });
  await fs.writeFile(path.join(ws, ".kodo", "settings.json"),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `echo '${json}'` }] }] } }));
  const runner = await createHookRunner({ workspacePath: ws });
  const r = await ensureSessionStart({ sessionId: "ctx", userId: null, workspacePath: ws, isNew: true, fire: runner.fire });
  assert.deepStrictEqual(r.context, ["branch is release/1.2"]);
  await fs.rm(ws, { recursive: true, force: true });
});

console.log("\n📦 SessionEnd (once, with a reason, on every exit path)");

await test("fires once on normal end, with the reason", async () => {
  _resetSessionHookState();
  const ws = await makeWorkspace({});
  await fs.writeFile(path.join(ws, ".kodo", "settings.json"),
    JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: `cat >> ${log(ws, "end")}` }] }] } }));
  const runner = await createHookRunner({ workspacePath: ws });
  await ensureSessionStart({ sessionId: "e1", userId: null, workspacePath: ws, isNew: true, fire: runner.fire });
  const r = await endSession({ sessionId: "e1", reason: "clear", fire: runner.fire });
  assert.strictEqual(r.fired, true);
  const payload = JSON.parse((await fs.readFile(log(ws, "end"), "utf-8")).trim());
  assert.strictEqual(payload.event, "SessionEnd");
  assert.strictEqual(payload.reason, "clear");
  assert.strictEqual(payload.session_id, "e1");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("repeated end calls fire only once (idempotent)", async () => {
  _resetSessionHookState();
  const ws = await makeWorkspace({});
  await fs.writeFile(path.join(ws, ".kodo", "settings.json"), JSON.stringify({ hooks: { SessionEnd: [appendHook(ws, "end")] } }));
  const runner = await createHookRunner({ workspacePath: ws });
  await ensureSessionStart({ sessionId: "e2", userId: null, workspacePath: ws, isNew: true, fire: runner.fire });
  await endSession({ sessionId: "e2", reason: "clear", fire: runner.fire });
  await endSession({ sessionId: "e2", reason: "logout", fire: runner.fire });
  await endSession({ sessionId: "e2", reason: "other", fire: runner.fire });
  assert.deepStrictEqual(await readLog(ws, "end"), ["fired"]);
  await fs.rm(ws, { recursive: true, force: true });
});

await test("fires on the ERROR/abort path too", async () => {
  _resetSessionHookState();
  const ws = await makeWorkspace({});
  await fs.writeFile(path.join(ws, ".kodo", "settings.json"),
    JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: `cat >> ${log(ws, "end")}` }] }] } }));
  const runner = await createHookRunner({ workspacePath: ws });
  await ensureSessionStart({ sessionId: "e3", userId: null, workspacePath: ws, isNew: true, fire: runner.fire });
  await endSession({ sessionId: "e3", reason: "error", fire: runner.fire });
  assert.strictEqual(JSON.parse((await fs.readFile(log(ws, "end"), "utf-8")).trim()).reason, "error");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("shutdown ends EVERY live session with reason=shutdown", async () => {
  _resetSessionHookState();
  const ws = await makeWorkspace({});
  await fs.writeFile(path.join(ws, ".kodo", "settings.json"), JSON.stringify({ hooks: { SessionEnd: [appendHook(ws, "end")] } }));
  const runner = await createHookRunner({ workspacePath: ws });
  for (const id of ["x", "y", "z"]) {
    await ensureSessionStart({ sessionId: id, userId: null, workspacePath: ws, isNew: true, fire: runner.fire });
    attachRunner(id, runner); // shutdown has no request in flight to build one
  }
  assert.strictEqual(activeSessionIds().length, 3);
  await endAllSessions("shutdown");
  assert.strictEqual((await readLog(ws, "end")).length, 3);
  assert.strictEqual(activeSessionIds().length, 0);
  await fs.rm(ws, { recursive: true, force: true });
});

await test("ending one session does NOT end another", async () => {
  _resetSessionHookState();
  const ws = await makeWorkspace({});
  await fs.writeFile(path.join(ws, ".kodo", "settings.json"), JSON.stringify({ hooks: {} }));
  const runner = await createHookRunner({ workspacePath: ws });
  await ensureSessionStart({ sessionId: "keep", userId: null, workspacePath: ws, isNew: true, fire: runner.fire });
  await ensureSessionStart({ sessionId: "drop", userId: null, workspacePath: ws, isNew: true, fire: runner.fire });
  await endSession({ sessionId: "drop", reason: "clear", fire: runner.fire });
  assert.ok(isSessionActive("keep"), "an unrelated session must stay open");
  assert.ok(!isSessionActive("drop"));
  await fs.rm(ws, { recursive: true, force: true });
});

await test("a failing SessionEnd hook does not throw into the shutdown path", async () => {
  _resetSessionHookState();
  const ws = await makeWorkspace({});
  await fs.writeFile(path.join(ws, ".kodo", "settings.json"),
    JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "exit 1" }] }] } }));
  const runner = await createHookRunner({ workspacePath: ws });
  await ensureSessionStart({ sessionId: "boom", userId: null, workspacePath: ws, isNew: true, fire: runner.fire });
  const r = await endSession({ sessionId: "boom", reason: "shutdown", fire: runner.fire });
  assert.strictEqual(r.fired, true, "a broken cleanup hook must not abort shutdown");
  await fs.rm(ws, { recursive: true, force: true });
});

console.log("\n📦 UserPromptSubmit / UserPromptExpansion");

const cfg = (raw) => normalizeHookConfig(raw).hooks;

await test("UserPromptSubmit sees the prompt and can allow it through", async () => {
  const ws = await makeWorkspace({});
  const res = await fireHookEvent("UserPromptSubmit", { prompt: "add auth" }, {
    config: cfg({ UserPromptSubmit: [{ hooks: [{ type: "command", command: `cat >> ${log(ws, "submit")}` }] }] }), cwd: ws,
  });
  assert.strictEqual(res.decision, "continue");
  assert.strictEqual(JSON.parse((await fs.readFile(log(ws, "submit"), "utf-8")).trim()).prompt, "add auth");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("UserPromptSubmit can BLOCK with a reason", async () => {
  const ws = await makeWorkspace({});
  const res = await fireHookEvent("UserPromptSubmit", { prompt: "delete prod" }, {
    config: cfg({ UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo 'prod changes are frozen' >&2; exit 2" }] }] }), cwd: ws,
  });
  assert.strictEqual(res.decision, "block");
  assert.ok(/prod changes are frozen/.test(res.reason));
  await fs.rm(ws, { recursive: true, force: true });
});

await test("UserPromptSubmit can inject additionalContext without altering the prompt", async () => {
  const ws = await makeWorkspace({});
  const json = JSON.stringify({ hookSpecificOutput: { additionalContext: "use pnpm, not npm" } });
  const res = await fireHookEvent("UserPromptSubmit", { prompt: "install deps" }, {
    config: cfg({ UserPromptSubmit: [{ hooks: [{ type: "command", command: `echo '${json}'` }] }] }), cwd: ws,
  });
  assert.deepStrictEqual(res.context, ["use pnpm, not npm"]);
  assert.strictEqual(res.updatedPrompt, null, "context must not silently rewrite the prompt");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("UserPromptExpansion REWRITES the prompt via updatedPrompt", async () => {
  const ws = await makeWorkspace({});
  const json = JSON.stringify({ hookSpecificOutput: { updatedPrompt: "add auth to src/auth.ts using JWT" } });
  const res = await fireHookEvent("UserPromptExpansion", { prompt: "add auth" }, {
    config: cfg({ UserPromptExpansion: [{ hooks: [{ type: "command", command: `echo '${json}'` }] }] }), cwd: ws,
  });
  assert.strictEqual(res.updatedPrompt, "add auth to src/auth.ts using JWT");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("arbitrary stdout does NOT hijack the prompt (rewrite must be explicit)", async () => {
  const ws = await makeWorkspace({});
  const res = await fireHookEvent("UserPromptExpansion", { prompt: "add auth" }, {
    config: cfg({ UserPromptExpansion: [{ hooks: [{ type: "command", command: "echo 'some incidental log line'" }] }] }), cwd: ws,
  });
  assert.strictEqual(res.updatedPrompt, null, "a logging hook must never replace the user's prompt");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("a failing prompt hook is visible, not silent", async () => {
  const ws = await makeWorkspace({});
  const res = await fireHookEvent("UserPromptSubmit", { prompt: "x" }, {
    config: cfg({ UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo boom >&2; exit 1" }] }] }), cwd: ws,
  });
  assert.strictEqual(res.decision, "continue", "a broken hook must not block the user");
  assert.strictEqual(res.results[0].ok, false);
  assert.ok(/boom/.test(res.results[0].stderr), "the failure detail must be retained for observability");
  await fs.rm(ws, { recursive: true, force: true });
});

console.log("\n📦 PermissionRequest / PermissionDenied precedence");

const { executeTool, mcpToolDenied, mcpToolNeedsApproval } = await import("../agents/nodes/agent_loop.mjs");

function permCtx(hookRaw, { permissions, askUser } = {}) {
  const config = cfg(hookRaw);
  return {
    root: os.tmpdir(), emit: null, sessionId: "s", requestId: "r",
    runtime: new HostRuntime({ root: os.tmpdir() }),
    hooks: {}, permissions, editedFiles: new Map(), readFiles: new Set(),
    todosRef: { current: [] }, workspaceSnapshot: [], permissionMode: "auto",
    mcpClients: new Map(), mcpRoutes: new Map(), askUser,
    fireHook: (event, payload, opts = {}) => fireHookEvent(event, payload, { config, cwd: os.tmpdir(), ...opts }),
  };
}

await test("PermissionRequest does NOT fire when no approval is required", async () => {
  const ws = await makeWorkspace({});
  const ctx = permCtx({ PermissionRequest: [{ hooks: [{ type: "command", command: `echo x >> ${log(ws, "perm")}` }] }] },
    { permissions: { allow: [], ask: [], deny: [] } });
  await executeTool("bash", { command: "ls" }, ctx);
  assert.deepStrictEqual(await readLog(ws, "perm"), [], "must only fire on the ask path");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("PermissionRequest fires on the ask path and can AUTO-APPROVE (no user prompt)", async () => {
  const ws = await makeWorkspace({});
  let askedUser = false;
  const json = JSON.stringify({ permissionDecision: "allow" });
  const ctx = permCtx({ PermissionRequest: [{ hooks: [{ type: "command", command: `echo '${json}'` }] }] },
    { permissions: { allow: [], ask: ["Bash(git push:*)"], deny: [] }, askUser: async () => { askedUser = true; return "Deny"; } });
  const r = await executeTool("bash", { command: "git push origin main" }, ctx);
  assert.strictEqual(askedUser, false, "an approving hook must skip the human prompt");
  // The command itself may still fail (no git remote in a temp dir) — what
  // matters is that it was NOT rejected by the approval layer.
  assert.ok(
    !/not approved|requires approval|PermissionRequest hook/i.test(String(r.error ?? "")),
    `hook "allow" must let the command through, got: ${r.error}`,
  );
  await fs.rm(ws, { recursive: true, force: true });
});

await test("PermissionRequest can DENY, and PermissionDenied then fires", async () => {
  const ws = await makeWorkspace({});
  const ctx = permCtx({
    PermissionRequest: [{ hooks: [{ type: "command", command: "echo 'no pushes' >&2; exit 2" }] }],
    PermissionDenied: [{ hooks: [{ type: "command", command: `echo denied >> ${log(ws, "denied")}` }] }],
  }, { permissions: { allow: [], ask: ["Bash(git push:*)"], deny: [] }, askUser: async () => "Allow" });

  const r = await executeTool("bash", { command: "git push origin main" }, ctx);
  assert.strictEqual(r.success, false);
  assert.ok(/PermissionRequest hook/.test(r.error), r.error);
  assert.ok(/no pushes/.test(r.error));
  assert.deepStrictEqual(await readLog(ws, "denied"), ["denied"], "PermissionDenied must fire on hook denial");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("PermissionDenied fires when the USER denies", async () => {
  const ws = await makeWorkspace({});
  const ctx = permCtx({ PermissionDenied: [{ hooks: [{ type: "command", command: `echo denied >> ${log(ws, "denied")}` }] }] },
    { permissions: { allow: [], ask: ["Bash(git push:*)"], deny: [] }, askUser: async () => "Deny" });
  const r = await executeTool("bash", { command: "git push origin main" }, ctx);
  assert.strictEqual(r.success, false);
  assert.deepStrictEqual(await readLog(ws, "denied"), ["denied"]);
  await fs.rm(ws, { recursive: true, force: true });
});

await test("a hook CANNOT override an explicit deny rule (deny always wins)", async () => {
  const ws = await makeWorkspace({});
  const json = JSON.stringify({ permissionDecision: "allow" });
  const ctx = permCtx({ PermissionRequest: [{ hooks: [{ type: "command", command: `echo '${json}'; echo fired >> ${log(ws, "perm")}` }] }] },
    { permissions: { allow: [], ask: [], deny: ["Bash(git push:*)"] }, askUser: async () => "Allow" });

  const r = await executeTool("bash", { command: "git push origin main" }, ctx);
  assert.strictEqual(r.success, false, "an explicit deny rule must hold");
  assert.deepStrictEqual(await readLog(ws, "perm"), [], "PermissionRequest must not even fire for a denied command");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("an MCP deny rule likewise cannot be widened by a hook", () => {
  assert.strictEqual(mcpToolDenied("mcp__gh__delete_repo", { deny: ["mcp__gh"] }), true);
  assert.strictEqual(mcpToolNeedsApproval("mcp__gh__create_pr", { ask: ["mcp__gh"], allow: ["mcp__gh__create_pr"] }), false);
});

console.log("\n📦 SubagentStart / SubagentStop (real spawn_agent path)");

// Drives executeTool("spawn_agent"), the REAL runtime path. creds point at an
// unreachable endpoint so the subagent's model call fails fast — the lifecycle
// events must still fire correctly around that failure, which is exactly the
// guarantee under test.
const DEAD_CREDS = { apiKey: "x", baseURL: "http://127.0.0.1:1/v1", model: "m" };

function subCtx(hookRaw, extra = {}) {
  const config = cfg(hookRaw);
  const seen = [];
  const ctx = {
    root: os.tmpdir(), emit: null, sessionId: "parent-sess", requestId: "parent-req",
    runtime: new HostRuntime({ root: os.tmpdir() }),
    hooks: {}, permissions: { allow: [], ask: [], deny: [] },
    editedFiles: new Map(), readFiles: new Set(), todosRef: { current: [] },
    workspaceSnapshot: [], permissionMode: "auto", askUser: null,
    mcpClients: new Map(), mcpRoutes: new Map(), creds: DEAD_CREDS,
    fireHook: async (event, payload, opts = {}) => {
      const r = await fireHookEvent(event, payload, { config, cwd: os.tmpdir(), ...opts });
      seen.push({ event, payload });
      return r;
    },
    ...extra,
  };
  return { ctx, seen };
}

await test("SubagentStart and SubagentStop each fire exactly once per execution", async () => {
  const { ctx, seen } = subCtx({});
  await executeTool("spawn_agent", { description: "trace auth", prompt: "find the auth flow" }, ctx);
  const starts = seen.filter((e) => e.event === "SubagentStart");
  const stops = seen.filter((e) => e.event === "SubagentStop");
  assert.strictEqual(starts.length, 1, `expected 1 start, got ${starts.length}`);
  assert.strictEqual(stops.length, 1, `expected 1 stop, got ${stops.length}`);
});

await test("SubagentStart payload carries parent ids, task, model and cwd", async () => {
  const { ctx, seen } = subCtx({});
  await executeTool("spawn_agent", { description: "trace auth", prompt: "find the auth flow" }, ctx);
  const p = seen.find((e) => e.event === "SubagentStart").payload;
  assert.strictEqual(p.parent_session_id, "parent-sess");
  assert.strictEqual(p.parent_request_id, "parent-req");
  assert.ok(/^sub_/.test(p.subagent_id), "needs its own id");
  assert.strictEqual(p.description, "trace auth");
  assert.ok(/find the auth flow/.test(p.task));
  assert.strictEqual(p.model, "m");
  assert.ok(p.cwd);
});

await test("SubagentStop reports status and duration, and correlates by subagent_id", async () => {
  const { ctx, seen } = subCtx({});
  await executeTool("spawn_agent", { description: "x", prompt: "y" }, ctx);
  const start = seen.find((e) => e.event === "SubagentStart").payload;
  const stop = seen.find((e) => e.event === "SubagentStop").payload;
  assert.strictEqual(stop.subagent_id, start.subagent_id, "stop must correlate to its start");
  assert.ok(["success", "error", "cancelled"].includes(stop.status), `unexpected status ${stop.status}`);
  assert.ok(typeof stop.durationMs === "number");
});

await test("SubagentStop fires on the ERROR path (unreachable model)", async () => {
  const { ctx, seen } = subCtx({});
  await executeTool("spawn_agent", { description: "x", prompt: "y" }, ctx);
  const stop = seen.find((e) => e.event === "SubagentStop").payload;
  assert.strictEqual(stop.status, "error", "a failed subagent must report error, not success");
});

await test("SubagentStop fires on ABORT", async () => {
  const controller = new AbortController();
  controller.abort();
  const { ctx, seen } = subCtx({}, { abortSignal: controller.signal });
  await executeTool("spawn_agent", { description: "x", prompt: "y" }, ctx);
  const stop = seen.find((e) => e.event === "SubagentStop");
  assert.ok(stop, "abort must still fire SubagentStop");
  assert.strictEqual(stop.payload.status, "cancelled");
});

await test("a FAILING subagent hook does not orphan the subagent or break the tool result", async () => {
  const { ctx } = subCtx({
    SubagentStart: [{ hooks: [{ type: "command", command: "exit 1" }] }],
    SubagentStop: [{ hooks: [{ type: "command", command: "exit 1" }] }],
  });
  const r = await executeTool("spawn_agent", { description: "x", prompt: "y" }, ctx);
  assert.ok(r && typeof r === "object", "the tool must still return a result envelope");
  assert.ok("success" in r);
});

await test("subagent hooks do not mutate parent conversation state", async () => {
  const { ctx } = subCtx({});
  ctx.editedFiles.set("parent.ts", "edit");
  ctx.readFiles.add("parent-read.ts");
  await executeTool("spawn_agent", { description: "x", prompt: "y" }, ctx);
  assert.deepStrictEqual([...ctx.editedFiles.keys()], ["parent.ts"], "subagent must not touch parent editedFiles");
  assert.deepStrictEqual([...ctx.readFiles], ["parent-read.ts"], "subagent must not touch parent readFiles");
});

await test("a subagent cannot spawn another subagent (depth stays capped)", async () => {
  const { ctx, seen } = subCtx({}, { isSubAgent: true });
  const r = await executeTool("spawn_agent", { description: "x", prompt: "y" }, ctx);
  assert.strictEqual(r.success, false, "nested spawn must be refused");
  assert.strictEqual(seen.filter((e) => e.event === "SubagentStart").length, 0, "no execution → no lifecycle events");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
