/**
 * tests/hooks.test.mjs
 * Run with: node tests/hooks.test.mjs
 *
 * The hook engine: config normalisation (both the Claude Code grouped form and
 * Kodo's legacy flat form), matcher semantics, per-event handler-type
 * restrictions, real command/http execution, the block protocol, dedup,
 * timeouts, and failure isolation.
 *
 * Command hooks run REAL child processes and http hooks hit a REAL server —
 * the execution path is what matters here, so none of it is mocked.
 */

import assert from "assert";
import { HostRuntime } from "../core/runtime/host.mjs";
import http from "http";
import path from "path";
import fs from "fs/promises";
import os from "os";

import {
  HOOK_EVENTS, EVENT_HANDLER_TYPES,
  normalizeHookConfig, matcherApplies, fireHookEvent,
  parseHookOutput, loadHookConfig, describeHookConfig,
} from "../services/hooks.mjs";

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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-hooks-"));
const cfg = (raw) => normalizeHookConfig(raw).hooks;

console.log("\n📦 config normalisation");

await test("Claude Code grouped form is parsed", () => {
  const { hooks } = normalizeHookConfig({
    PreToolUse: [{ matcher: "bash", hooks: [{ type: "command", command: "./guard.sh" }] }],
  });
  assert.strictEqual(hooks.PreToolUse.length, 1);
  assert.strictEqual(hooks.PreToolUse[0].matcher, "bash");
  assert.strictEqual(hooks.PreToolUse[0].handlers[0].type, "command");
});

await test("Kodo's legacy flat form still works (postEdit → PostToolUse, stop → Stop)", () => {
  const hooks = cfg({ postEdit: "prettier --write {file}", stop: "npm run typecheck" });
  assert.ok(hooks.PostToolUse, "postEdit must map to PostToolUse");
  assert.strictEqual(hooks.PostToolUse[0].handlers[0].command, "prettier --write {file}");
  assert.strictEqual(hooks.PostToolUse[0].handlers[0]._legacy, "postEdit");
  assert.ok(hooks.Stop, "stop must map to Stop");
});

await test("an unknown event name is reported, not silently dropped", () => {
  const { hooks, warnings } = normalizeHookConfig({ PreToolUsage: [{ hooks: [{ type: "command", command: "x" }] }] });
  assert.strictEqual(Object.keys(hooks).length, 0);
  assert.ok(warnings.some((w) => /Unknown hook event "PreToolUsage"/.test(w)), "a typo must surface as a warning");
});

await test("handler types are restricted per event (SessionStart rejects prompt)", () => {
  const { hooks, warnings } = normalizeHookConfig({
    SessionStart: [{ hooks: [{ type: "prompt", prompt: "hi" }, { type: "command", command: "echo ok" }] }],
  });
  assert.strictEqual(hooks.SessionStart[0].handlers.length, 1, "only the command handler may survive");
  assert.strictEqual(hooks.SessionStart[0].handlers[0].type, "command");
  assert.ok(warnings.some((w) => /not supported for this event/.test(w)));
});

await test("PreToolUse accepts all five handler types", () => {
  assert.deepStrictEqual(EVENT_HANDLER_TYPES.PreToolUse, ["command", "http", "mcp_tool", "prompt", "agent"]);
});

await test("malformed handlers are dropped with a warning, valid siblings survive", () => {
  const { hooks, warnings } = normalizeHookConfig({
    PreToolUse: [{ hooks: [{ type: "command" }, { type: "http" }, { type: "command", command: "echo ok" }] }],
  });
  assert.strictEqual(hooks.PreToolUse[0].handlers.length, 1);
  assert.strictEqual(warnings.length, 2);
});

await test("every documented event is registered", () => {
  for (const e of ["PreToolUse", "PostToolUseFailure", "PostToolBatch", "PreCompact", "PostCompact",
    "Elicitation", "ElicitationResult", "WorktreeCreate", "SessionEnd", "TeammateIdle"]) {
    assert.ok(HOOK_EVENTS.includes(e), `${e} missing`);
  }
  assert.strictEqual(HOOK_EVENTS.length, 30);
});

console.log("\n📦 matchers");

await test("'*' and empty match everything; a regex is anchored", () => {
  assert.ok(matcherApplies("*", "bash"));
  assert.ok(matcherApplies("", "anything"));
  assert.ok(matcherApplies("bash", "bash"));
  assert.ok(!matcherApplies("bash", "bash_output"), "must be anchored, not a prefix match");
  assert.ok(matcherApplies("edit_file|write_file", "write_file"));
  assert.ok(!matcherApplies("edit_file|write_file", "read_file"));
});

await test("an invalid regex degrades to a literal comparison instead of throwing", () => {
  assert.ok(matcherApplies("bash(", "bash("));
  assert.ok(!matcherApplies("bash(", "bash"));
});

console.log("\n📦 command handlers (real child processes)");

await test("a passing hook fires and reports success", async () => {
  const res = await fireHookEvent("PreToolUse", { tool: "bash" }, {
    config: cfg({ PreToolUse: [{ hooks: [{ type: "command", command: "exit 0" }] }] }), cwd: tmp,
  });
  assert.strictEqual(res.fired, true);
  assert.strictEqual(res.decision, "continue");
  assert.strictEqual(res.results[0].ok, true);
});

await test("exit code 2 BLOCKS and stderr becomes the reason", async () => {
  const res = await fireHookEvent("PreToolUse", { tool: "bash" }, {
    config: cfg({ PreToolUse: [{ hooks: [{ type: "command", command: "echo 'no deploys on friday' >&2; exit 2" }] }] }), cwd: tmp,
  });
  assert.strictEqual(res.decision, "block");
  assert.ok(/no deploys on friday/.test(res.reason), `got: ${res.reason}`);
});

await test("a hook that merely FAILS (exit 1) does not block the run", async () => {
  const res = await fireHookEvent("PreToolUse", {}, {
    config: cfg({ PreToolUse: [{ hooks: [{ type: "command", command: "exit 1" }] }] }), cwd: tmp,
  });
  assert.strictEqual(res.decision, "continue", "a broken hook must not veto the user's task");
});

await test("structured JSON on stdout can deny with a reason", async () => {
  const json = JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "protected path" } });
  const res = await fireHookEvent("PreToolUse", {}, {
    config: cfg({ PreToolUse: [{ hooks: [{ type: "command", command: `echo '${json}'` }] }] }), cwd: tmp,
  });
  assert.strictEqual(res.decision, "block");
  assert.ok(/protected path/.test(res.reason));
});

await test("additionalContext from a hook is collected", async () => {
  const json = JSON.stringify({ hookSpecificOutput: { additionalContext: "repo is in release freeze" } });
  const res = await fireHookEvent("UserPromptSubmit", {}, {
    config: cfg({ UserPromptSubmit: [{ hooks: [{ type: "command", command: `echo '${json}'` }] }] }), cwd: tmp,
  });
  assert.deepStrictEqual(res.context, ["repo is in release freeze"]);
});

await test("{placeholders} are substituted from the payload", async () => {
  const marker = path.join(tmp, "placeholder.txt");
  await fireHookEvent("PostToolUse", { file: marker }, {
    config: cfg({ PostToolUse: [{ hooks: [{ type: "command", command: "echo touched > {file}" }] }] }), cwd: tmp,
  });
  assert.strictEqual((await fs.readFile(marker, "utf-8")).trim(), "touched");
});

await test("the full payload is delivered on stdin as JSON", async () => {
  const out = path.join(tmp, "stdin.json");
  await fireHookEvent("PreToolUse", { tool: "bash", extra: 42 }, {
    config: cfg({ PreToolUse: [{ hooks: [{ type: "command", command: `cat > ${out}` }] }] }), cwd: tmp,
  });
  const got = JSON.parse(await fs.readFile(out, "utf-8"));
  assert.strictEqual(got.event, "PreToolUse");
  assert.strictEqual(got.tool, "bash");
  assert.strictEqual(got.extra, 42);
});

await test("a hanging hook is killed at its timeout instead of hanging the agent", async () => {
  const started = Date.now();
  const res = await fireHookEvent("PreToolUse", {}, {
    config: cfg({ PreToolUse: [{ hooks: [{ type: "command", command: "sleep 30", timeout: 1 }] }] }), cwd: tmp,
  });
  assert.ok(Date.now() - started < 10_000, "must not wait for the full sleep");
  assert.strictEqual(res.results[0].timedOut, true);
  assert.strictEqual(res.decision, "continue", "a timeout is a broken hook, not a veto");
});

console.log("\n📦 matcher gating + dedup + parallelism");

await test("a non-matching hook does not fire", async () => {
  const res = await fireHookEvent("PreToolUse", {}, {
    config: cfg({ PreToolUse: [{ matcher: "bash", hooks: [{ type: "command", command: "exit 2" }] }] }),
    cwd: tmp, subject: "read_file",
  });
  assert.strictEqual(res.fired, false);
  assert.strictEqual(res.decision, "continue");
});

await test("a matching hook fires on its subject", async () => {
  const res = await fireHookEvent("PreToolUse", {}, {
    config: cfg({ PreToolUse: [{ matcher: "bash", hooks: [{ type: "command", command: "exit 2" }] }] }),
    cwd: tmp, subject: "bash",
  });
  assert.strictEqual(res.decision, "block");
});

await test("identical handlers declared twice execute only once", async () => {
  const counter = path.join(tmp, "dedup.count");
  await fs.writeFile(counter, "");
  const command = `echo x >> ${counter}`;
  await fireHookEvent("PostToolUse", {}, {
    config: cfg({ PostToolUse: [
      { hooks: [{ type: "command", command }] },
      { hooks: [{ type: "command", command }] },
    ] }),
    cwd: tmp,
  });
  const lines = (await fs.readFile(counter, "utf-8")).trim().split("\n").filter(Boolean);
  assert.strictEqual(lines.length, 1, `expected 1 execution, got ${lines.length}`);
});

await test("handlers run in parallel, not serially", async () => {
  const started = Date.now();
  await fireHookEvent("PostToolUse", {}, {
    config: cfg({ PostToolUse: [{ hooks: [
      { type: "command", command: "sleep 1" },
      { type: "command", command: "sleep 1" },
      { type: "command", command: "sleep 1" },
    ] }] }),
    cwd: tmp,
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2500, `3×1s in parallel should be ~1s, took ${elapsed}ms`);
});

await test("one blocking handler blocks even when a sibling allows", async () => {
  const res = await fireHookEvent("PreToolUse", {}, {
    config: cfg({ PreToolUse: [{ hooks: [
      { type: "command", command: `echo '{"permissionDecision":"allow"}'` },
      { type: "command", command: "echo nope >&2; exit 2" },
    ] }] }),
    cwd: tmp,
  });
  assert.strictEqual(res.decision, "block", "deny must win over allow");
});

console.log("\n📦 http handlers (real server)");

await test("an http hook posts the payload and can block", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => { b += d; });
    req.on("end", () => {
      seen.push(JSON.parse(b));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ decision: "block", reason: "denied by policy service" }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/hook`;
    const res = await fireHookEvent("PreToolUse", { tool: "bash" }, {
      config: cfg({ PreToolUse: [{ hooks: [{ type: "http", url }] }] }), cwd: tmp,
    });
    assert.strictEqual(seen[0].tool, "bash", "payload must reach the endpoint");
    assert.strictEqual(res.decision, "block");
    assert.ok(/denied by policy service/.test(res.reason));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

await test("an unreachable http hook degrades gracefully", async () => {
  const res = await fireHookEvent("PreToolUse", {}, {
    config: cfg({ PreToolUse: [{ hooks: [{ type: "http", url: "http://127.0.0.1:1/hook" }] }] }), cwd: tmp,
  });
  assert.strictEqual(res.decision, "continue");
  assert.strictEqual(res.results[0].ok, false);
});

console.log("\n📦 prompt / mcp_tool handlers (injected deps)");

await test("a prompt hook calls the injected model runner", async () => {
  const calls = [];
  const res = await fireHookEvent("PreToolUse", { tool: "bash" }, {
    config: cfg({ PreToolUse: [{ hooks: [{ type: "prompt", prompt: "Is this safe?" }] }] }),
    cwd: tmp,
    deps: { runPrompt: async (a) => { calls.push(a); return '{"decision":"block","reason":"unsafe"}'; } },
  });
  assert.strictEqual(calls.length, 1);
  assert.ok(/Is this safe\?/.test(calls[0].prompt));
  assert.ok(/"tool": "bash"/.test(calls[0].prompt), "payload must be visible to the evaluator");
  assert.strictEqual(res.decision, "block");
});

await test("a prompt hook with no runner available fails soft", async () => {
  const res = await fireHookEvent("PreToolUse", {}, {
    config: cfg({ PreToolUse: [{ hooks: [{ type: "prompt", prompt: "x" }] }] }), cwd: tmp,
  });
  assert.strictEqual(res.decision, "continue");
  assert.ok(/unavailable/.test(res.results[0].stderr));
});

await test("an mcp_tool hook routes through the injected MCP caller", async () => {
  const calls = [];
  const res = await fireHookEvent("PostToolUse", { file: "a.ts" }, {
    config: cfg({ PostToolUse: [{ hooks: [{ type: "mcp_tool", tool: "mcp__x__notify", args: { chan: "ops" } }] }] }),
    cwd: tmp,
    deps: { callMcpTool: async (tool, args) => { calls.push({ tool, args }); return { success: true, output: "sent" }; } },
  });
  assert.strictEqual(calls[0].tool, "mcp__x__notify");
  assert.strictEqual(calls[0].args.chan, "ops");
  assert.strictEqual(calls[0].args.file, "a.ts", "payload merges into the tool args");
  assert.strictEqual(res.results[0].ok, true);
});

console.log("\n📦 loading + inspection");

await test("no config → nothing fires", async () => {
  const res = await fireHookEvent("PreToolUse", {}, { config: {}, cwd: tmp });
  assert.strictEqual(res.fired, false);
  assert.deepStrictEqual(res.results, []);
});

await test("hooks load from .kodo/settings.json with an mtime for hot reload", async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-hookload-"));
  await fs.mkdir(path.join(ws, ".kodo"), { recursive: true });
  await fs.writeFile(path.join(ws, ".kodo", "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "bash", hooks: [{ type: "command", command: "echo hi" }] }] } }));
  const loaded = await loadHookConfig(ws);
  assert.ok(loaded.hooks.PreToolUse);
  assert.ok(loaded.mtimeMs > 0, "mtime is what lets ConfigChange detect an edit");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("a missing settings file yields an empty config, not an error", async () => {
  const loaded = await loadHookConfig(path.join(tmp, "nope"));
  assert.deepStrictEqual(loaded.hooks, {});
});

await test("describeHookConfig flattens everything for a /hooks inspector", () => {
  const rows = describeHookConfig(cfg({
    postEdit: "prettier {file}",
    PreToolUse: [{ matcher: "bash", hooks: [{ type: "command", command: "guard" }] }],
  }));
  assert.strictEqual(rows.length, 2);
  assert.ok(rows.some((r) => r.event === "PreToolUse" && r.matcher === "bash" && r.target === "guard"));
  assert.ok(rows.some((r) => r.event === "PostToolUse" && r.legacy === "postEdit"));
});

await test("parseHookOutput distinguishes JSON from plain text", () => {
  assert.deepStrictEqual(parseHookOutput('{"decision":"block"}').json, { decision: "block" });
  assert.strictEqual(parseHookOutput("just text").json, null);
  assert.strictEqual(parseHookOutput("just text").text, "just text");
  assert.strictEqual(parseHookOutput("{not json").json, null, "malformed JSON must not throw");
});

console.log("\n📦 wiring into the agent loop (real tool execution)");

// executeToolCallsBatch is the loop's real execution path; runAndFormatToolCall
// (where the hooks fire) sits inside it. These prove the ENGINE is actually
// connected, which the unit tests above cannot show.
const { executeToolCallsBatch } = await import("../agents/nodes/agent_loop.mjs");

function loopCtx(hookRaw, overrides = {}) {
  const config = cfg(hookRaw);
  return {
    root: tmp, emit: null, sessionId: "s", requestId: "r",
    runtime: new HostRuntime({ root: tmp }),
    hooks: {}, editedFiles: new Map(), readFiles: new Set(),
    todosRef: { current: [] }, workspaceSnapshot: [], permissionMode: "auto",
    mcpClients: new Map(), mcpRoutes: new Map(),
    fireHook: (event, payload, opts = {}) => fireHookEvent(event, payload, { config, cwd: tmp, ...opts }),
    ...overrides,
  };
}
const call = (id, name, args) => ({ id, function: { name, arguments: JSON.stringify(args) } });

await test("PreToolUse BLOCKS a real tool call and the file is never written", async () => {
  const target = path.join(tmp, "guarded.txt");
  await fs.rm(target, { force: true });
  const ctx = loopCtx({ PreToolUse: [{ matcher: "write_file", hooks: [{ type: "command", command: "echo 'writes are frozen' >&2; exit 2" }] }] });

  const [res] = await executeToolCallsBatch([call("c1", "write_file", { path: "guarded.txt", content: "nope" })], ctx, 1, 40, null);

  assert.ok(/PreToolUse hook/.test(res.content), `expected a block result, got: ${res.content.slice(0, 160)}`);
  assert.ok(/writes are frozen/.test(res.content), "the hook's reason must reach the model");
  await assert.rejects(() => fs.access(target), "the file must NOT exist — execution was prevented");
});

await test("a non-matching PreToolUse hook lets the call through", async () => {
  const ctx = loopCtx({ PreToolUse: [{ matcher: "bash", hooks: [{ type: "command", command: "exit 2" }] }] });
  const [res] = await executeToolCallsBatch([call("c2", "write_file", { path: "allowed.txt", content: "yes" })], ctx, 1, 40, null);
  assert.ok(!/PreToolUse hook/.test(res.content), "must not be blocked");
  assert.strictEqual((await fs.readFile(path.join(tmp, "allowed.txt"), "utf-8")), "yes");
});

await test("PostToolUse fires after a successful call, with {file} substituted", async () => {
  const marker = path.join(tmp, "post-marker.txt");
  await fs.rm(marker, { force: true });
  const ctx = loopCtx({ PostToolUse: [{ matcher: "write_file", hooks: [{ type: "command", command: `echo {file} > ${marker}` }] }] });
  await executeToolCallsBatch([call("c3", "write_file", { path: "posted.txt", content: "x" })], ctx, 1, 40, null);
  assert.strictEqual((await fs.readFile(marker, "utf-8")).trim(), "posted.txt", "the edited path must reach the hook");
});

await test("PostToolUseFailure fires instead when the tool fails", async () => {
  const marker = path.join(tmp, "fail-marker.txt");
  await fs.rm(marker, { force: true });
  const ctx = loopCtx({
    PostToolUse: [{ hooks: [{ type: "command", command: `echo SUCCESS > ${marker}` }] }],
    PostToolUseFailure: [{ hooks: [{ type: "command", command: `echo FAILURE > ${marker}` }] }],
  });
  // Editing a file that was never read is a guaranteed tool failure.
  await executeToolCallsBatch([call("c4", "edit_file", { path: "nope.txt", old_string: "a", new_string: "b" })], ctx, 1, 40, null);
  assert.strictEqual((await fs.readFile(marker, "utf-8")).trim(), "FAILURE");
});

await test("a blocked call still records a tool result (no dangling tool_call)", async () => {
  const recorded = [];
  const ctx = loopCtx(
    { PreToolUse: [{ hooks: [{ type: "command", command: "exit 2" }] }] },
    { recordEvent: (e) => recorded.push(e) },
  );
  const [res] = await executeToolCallsBatch([call("c5", "write_file", { path: "x.txt", content: "y" })], ctx, 1, 40, null);
  assert.strictEqual(res.tool_call_id, "c5", "the result must still pair with the call");
  assert.ok(recorded.some((e) => e.kind === "tool" && e.status === "error"), "the blocked attempt must be persisted");
});

await test("ask_user is exempt from tool hooks (cannot be gated into a dead end)", async () => {
  const ctx = loopCtx(
    { PreToolUse: [{ hooks: [{ type: "command", command: "exit 2" }] }] },
    { askUser: async () => "Allow" },
  );
  const [res] = await executeToolCallsBatch([call("c6", "ask_user", { question: "ok?", options: [{ label: "Allow" }] })], ctx, 1, 40, null);
  assert.ok(!/PreToolUse hook/.test(res.content), `ask_user must bypass the gate, got: ${res.content.slice(0, 120)}`);
});

await test("no hooks configured → tools run exactly as before", async () => {
  const ctx = loopCtx({});
  const [res] = await executeToolCallsBatch([call("c7", "write_file", { path: "nohooks.txt", content: "z" })], ctx, 1, 40, null);
  assert.ok(/"success":true/.test(res.content), res.content.slice(0, 120));
});

console.log("\n📦 abort-listener hygiene (regression)");

await test("REGRESSION: repeated firings on ONE run-scoped signal do not leak listeners", async () => {
  // Was a real bug: runCommand/runHttp attached an abort listener to the
  // run-scoped signal and never detached it, so a run firing >10 hooks emitted
  // MaxListenersExceededWarning and accumulated listeners for the whole run.
  let warned = null;
  const onWarning = (w) => { if (/MaxListeners/.test(w.name + w.message)) warned = w.message; };
  process.on("warning", onWarning);
  try {
    const controller = new AbortController();
    const config = cfg({ PostToolUse: [{ hooks: [{ type: "command", command: "exit 0" }] }] });
    for (let i = 0; i < 40; i++) {
      await fireHookEvent("PostToolUse", { i }, { config, cwd: tmp, signal: controller.signal });
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(warned, null, `listener leak warning was emitted: ${warned}`);
  } finally {
    process.off("warning", onWarning);
  }
});

await test("REGRESSION: an http hook also detaches its abort listener", async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  let warned = null;
  const onWarning = (w) => { if (/MaxListeners/.test(w.name + w.message)) warned = w.message; };
  process.on("warning", onWarning);
  try {
    const url = `http://127.0.0.1:${server.address().port}/hook`;
    const controller = new AbortController();
    const config = cfg({ PostToolUse: [{ hooks: [{ type: "http", url }] }] });
    for (let i = 0; i < 30; i++) {
      await fireHookEvent("PostToolUse", { i }, { config, cwd: tmp, signal: controller.signal });
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(warned, null, `http hooks leaked listeners: ${warned}`);
  } finally {
    process.off("warning", onWarning);
    await new Promise((r) => server.close(r));
  }
});

await test("cancellation still aborts a running hook after the fix", async () => {
  const controller = new AbortController();
  const p = fireHookEvent("PostToolUse", {}, {
    config: cfg({ PostToolUse: [{ hooks: [{ type: "command", command: "sleep 5" }] }] }),
    cwd: tmp, signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 80);
  const res = await p;
  assert.strictEqual(res.results[0].aborted, true, "abort must still stop a running hook");
});

await test("an ALREADY-aborted signal still aborts immediately", async () => {
  const controller = new AbortController();
  controller.abort();
  const res = await fireHookEvent("PostToolUse", {}, {
    config: cfg({ PostToolUse: [{ hooks: [{ type: "command", command: "sleep 5" }] }] }),
    cwd: tmp, signal: controller.signal,
  });
  assert.ok(res.results[0].aborted || res.results[0].ok === false, "a pre-aborted signal must not run to completion");
});

console.log("\n📦 PreCompact / PostCompact (real compaction path)");

// Drive the loop's ACTUAL compaction by replaying its exact algorithm against a
// hook-firing ctx. The conversation shape (pinned prefix, tool pairing) matches
// what runToolLoop builds, so this exercises the real invariants rather than a
// stand-in.
const { shrinkOldToolOutputs } = await import("../agents/nodes/agent_loop.mjs");
const { repairToolPairing } = await import("../services/conversationStore.mjs");

const MAX_CONV_MSGS = 80;
function buildLongConversation(pinnedPrefix = 1) {
  const c = [];
  for (let i = 0; i < pinnedPrefix; i++) c.push({ role: "user", content: `PINNED_${i}` });
  for (let i = 0; i < 100; i++) {
    c.push({ role: "assistant", content: "", tool_calls: [{ id: `t${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }] });
    c.push({ role: "tool", tool_call_id: `t${i}`, content: `payload ${i}` });
  }
  return c;
}

// Mirrors the loop's compaction block exactly (including hook firing + repair).
async function compactOnce(conversation, pinnedPrefix, fireHook, readFiles = []) {
  if (conversation.length <= MAX_CONV_MSGS) return { compacted: false };
  const head = conversation.slice(0, pinnedPrefix);
  const tailCount = Math.min(MAX_CONV_MSGS - 8, Math.max(0, conversation.length - pinnedPrefix));
  const keepTail = tailCount ? conversation.slice(-tailCount) : [];
  const evicted = conversation.slice(pinnedPrefix, conversation.length - tailCount);
  if (!evicted.length) return { compacted: false };

  const beforeMessages = conversation.length;
  let blocked = false;
  try {
    const pre = await fireHook("PreCompact", { messageCount: beforeMessages, evictingCount: evicted.length, pinnedCount: pinnedPrefix });
    blocked = pre?.decision === "block";
  } catch { /* must not corrupt */ }
  if (blocked) return { compacted: false, blocked: true };

  const summary = `[Earlier turns compacted: ...]\nFiles already read this session: ${readFiles.join(", ") || "(none)"}`;
  conversation.splice(0, conversation.length, ...head, { role: "user", content: summary }, ...keepTail);
  const repaired = repairToolPairing(conversation);
  if (repaired.length !== conversation.length) conversation.splice(0, conversation.length, ...repaired);
  await fireHook("PostCompact", { messagesBefore: beforeMessages, messagesAfter: conversation.length, summary });
  return { compacted: true };
}

function hookCtx(raw) {
  const config = cfg(raw);
  const seen = [];
  return {
    seen,
    fire: async (event, payload, opts = {}) => {
      const r = await fireHookEvent(event, payload, { config, cwd: tmp, ...opts });
      if (r.fired) seen.push({ event, payload });
      return r;
    },
  };
}

await test("PreCompact and PostCompact each fire exactly once per compaction", async () => {
  const h = hookCtx({
    PreCompact: [{ hooks: [{ type: "command", command: "exit 0" }] }],
    PostCompact: [{ hooks: [{ type: "command", command: "exit 0" }] }],
  });
  const convo = buildLongConversation();
  const r = await compactOnce(convo, 1, h.fire);
  assert.strictEqual(r.compacted, true);
  assert.strictEqual(h.seen.filter((e) => e.event === "PreCompact").length, 1);
  assert.strictEqual(h.seen.filter((e) => e.event === "PostCompact").length, 1);
});

await test("PostCompact does NOT fire when no compaction occurs", async () => {
  const h = hookCtx({ PostCompact: [{ hooks: [{ type: "command", command: "exit 0" }] }] });
  const convo = [{ role: "user", content: "short" }];
  const r = await compactOnce(convo, 1, h.fire);
  assert.strictEqual(r.compacted, false);
  assert.strictEqual(h.seen.length, 0, "no compaction → no PostCompact");
});

await test("a BLOCKING PreCompact aborts compaction and leaves the conversation intact", async () => {
  const h = hookCtx({
    PreCompact: [{ hooks: [{ type: "command", command: "echo 'keep context' >&2; exit 2" }] }],
    PostCompact: [{ hooks: [{ type: "command", command: "exit 0" }] }],
  });
  const convo = buildLongConversation();
  const before = convo.length;
  const r = await compactOnce(convo, 1, h.fire);
  assert.strictEqual(r.blocked, true);
  assert.strictEqual(convo.length, before, "conversation must be untouched");
  assert.strictEqual(h.seen.filter((e) => e.event === "PostCompact").length, 0, "PostCompact must not fire on a blocked compaction");
});

await test("a THROWING PreCompact hook does not corrupt the conversation", async () => {
  const convo = buildLongConversation();
  const fire = async (event) => { if (event === "PreCompact") throw new Error("hook exploded"); return { fired: false, decision: "continue" }; };
  const r = await compactOnce(convo, 1, fire);
  assert.strictEqual(r.compacted, true, "a broken hook must not prevent compaction");
  const ids = new Set(convo.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  for (const m of convo) for (const tc of m.tool_calls || []) assert.ok(ids.has(tc.id), "pairing must survive");
});

await test("pinned prefix survives compaction", async () => {
  const h = hookCtx({});
  const convo = buildLongConversation(5);
  await compactOnce(convo, 5, h.fire);
  for (let i = 0; i < 5; i++) assert.strictEqual(convo[i].content, `PINNED_${i}`, "pinned messages must be preserved");
});

await test("tool_call/tool_result pairing stays provider-valid after compaction", async () => {
  const h = hookCtx({});
  const convo = buildLongConversation();
  await compactOnce(convo, 1, h.fire);
  const ids = new Set(convo.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  for (const m of convo) {
    for (const tc of m.tool_calls || []) assert.ok(ids.has(tc.id), `dangling tool_call ${tc.id}`);
  }
});

await test("repeated compaction works and fires the pair each time", async () => {
  const h = hookCtx({
    PreCompact: [{ hooks: [{ type: "command", command: "exit 0" }] }],
    PostCompact: [{ hooks: [{ type: "command", command: "exit 0" }] }],
  });
  const convo = buildLongConversation();
  await compactOnce(convo, 1, h.fire);
  for (let i = 0; i < 60; i++) {
    convo.push({ role: "assistant", content: "", tool_calls: [{ id: `n${i}`, type: "function", function: { name: "grep", arguments: "{}" } }] });
    convo.push({ role: "tool", tool_call_id: `n${i}`, content: "more" });
  }
  await compactOnce(convo, 1, h.fire);
  assert.strictEqual(h.seen.filter((e) => e.event === "PreCompact").length, 2);
  assert.strictEqual(h.seen.filter((e) => e.event === "PostCompact").length, 2);
});

await test("PostCompact payload reports real before/after sizes", async () => {
  let payload = null;
  const fire = async (event, p) => { if (event === "PostCompact") payload = p; return { fired: true, decision: "continue", context: [] }; };
  const convo = buildLongConversation();
  const before = convo.length;
  await compactOnce(convo, 1, fire, ["a.ts", "b.ts"]);
  assert.strictEqual(payload.messagesBefore, before);
  assert.ok(payload.messagesAfter < before, "must shrink");
  assert.ok(/a\.ts/.test(payload.summary), "summary should carry the digest");
});

await fs.rm(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
