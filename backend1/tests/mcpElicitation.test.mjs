/**
 * tests/mcpElicitation.test.mjs
 * Run with: node tests/mcpElicitation.test.mjs
 *
 * MCP elicitation — a server asking the USER for input (never the model; that
 * is sampling). Covers the interaction manager, the elicitation handler's
 * safety rules, and a REAL stdio MCP server issuing `elicitation/create` and
 * receiving a correlated reply.
 *
 * The security-critical property under test: nothing auto-answers. Timeouts,
 * aborts, malformed requests and hook vetoes all resolve as decline/cancel —
 * never accept.
 */

import assert from "assert";
import path from "path";
import fs from "fs/promises";
import os from "os";

import { InteractionManager } from "../services/interactionManager.mjs";
import { makeElicitationHandler, closeMcpPool } from "../services/mcpTools.mjs";
import { spawnMcpServer } from "../services/mcpClient.mjs";
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

const cfg = (raw) => normalizeHookConfig(raw).hooks;
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-elicit-"));
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

console.log("\n📦 InteractionManager");

await test("an interaction is created pending and emits for a transport", async () => {
  const m = new InteractionManager();
  const seen = [];
  m.on("pending", (e) => seen.push(e));
  const { id } = m.create({ sessionId: "s", message: "API key?" });
  assert.ok(id);
  assert.strictEqual(m.size, 1);
  assert.strictEqual(seen[0].message, "API key?");
  m.disposeAll();
});

await test("respond(accept) settles with the user's content", async () => {
  const m = new InteractionManager();
  const { id, promise } = m.create({ sessionId: "s", message: "name?" });
  assert.strictEqual(m.respond(id, { action: "accept", content: { name: "kian" } }), true);
  assert.deepStrictEqual(await promise, { action: "accept", content: { name: "kian" }, reason: "" });
  assert.strictEqual(m.size, 0, "settled interactions must not leak");
});

await test("a TIMEOUT resolves as cancel — never as acceptance", async () => {
  const m = new InteractionManager();
  const { promise } = m.create({ sessionId: "s", message: "slow", timeoutMs: 80 });
  const out = await promise;
  assert.strictEqual(out.action, "cancel", "silence must never be read as approval");
  assert.ok(/timed out/.test(out.reason));
  assert.strictEqual(m.size, 0);
});

await test("an ABORT signal cancels the interaction", async () => {
  const m = new InteractionManager();
  const controller = new AbortController();
  const { promise } = m.create({ sessionId: "s", message: "x", signal: controller.signal });
  controller.abort();
  assert.strictEqual((await promise).action, "cancel");
});

await test("an already-aborted signal cancels immediately", async () => {
  const m = new InteractionManager();
  const controller = new AbortController();
  controller.abort();
  const { promise } = m.create({ sessionId: "s", message: "x", signal: controller.signal });
  assert.strictEqual((await promise).action, "cancel");
});

await test("responding twice is a no-op (replay-safe)", async () => {
  const m = new InteractionManager();
  const { id, promise } = m.create({ sessionId: "s", message: "x" });
  assert.strictEqual(m.respond(id, { action: "accept", content: { a: 1 } }), true);
  assert.strictEqual(m.respond(id, { action: "accept", content: { a: 2 } }), false, "duplicate submit must be ignored");
  assert.deepStrictEqual((await promise).content, { a: 1 });
});

await test("an unknown id is rejected safely", () => {
  const m = new InteractionManager();
  assert.strictEqual(m.respond("int_nope", { action: "accept" }), false);
  assert.strictEqual(m.cancel("int_nope"), false);
});

await test("an unrecognised action degrades to decline, never accept", async () => {
  const m = new InteractionManager();
  const { id, promise } = m.create({ sessionId: "s", message: "x" });
  m.respond(id, { action: "yolo", content: { secret: 1 } });
  const out = await promise;
  assert.strictEqual(out.action, "decline");
  assert.strictEqual(out.content, null, "content must not survive a non-accept outcome");
});

await test("CONCURRENT interactions stay independently correlated", async () => {
  const m = new InteractionManager();
  const a = m.create({ sessionId: "s", message: "first" });
  const b = m.create({ sessionId: "s", message: "second" });
  const c = m.create({ sessionId: "s", message: "third" });
  assert.strictEqual(m.size, 3);
  m.respond(b.id, { action: "accept", content: { which: "b" } });
  m.respond(a.id, { action: "decline" });
  m.cancel(c.id, "nope");
  assert.strictEqual((await a.promise).action, "decline");
  assert.deepStrictEqual((await b.promise).content, { which: "b" });
  assert.strictEqual((await c.promise).action, "cancel");
  assert.strictEqual(m.size, 0);
});

await test("cancelSession settles only that session's interactions", async () => {
  const m = new InteractionManager();
  const mine = m.create({ sessionId: "s1", message: "x" });
  const other = m.create({ sessionId: "s2", message: "y" });
  assert.strictEqual(m.cancelSession("s1"), 1);
  assert.strictEqual((await mine.promise).action, "cancel");
  assert.strictEqual(m.size, 1, "the other session must be untouched");
  m.disposeAll();
  await other.promise;
});

await test("pending interactions are capped per session (resource bound)", async () => {
  const m = new InteractionManager({ maxPerSession: 3 });
  const kept = [m.create({ sessionId: "s", message: "1" }), m.create({ sessionId: "s", message: "2" }), m.create({ sessionId: "s", message: "3" })];
  const overflow = m.create({ sessionId: "s", message: "4" });
  assert.strictEqual(overflow.id, null);
  assert.strictEqual((await overflow.promise).action, "cancel");
  assert.strictEqual(m.size, 3);
  m.disposeAll();
  await Promise.all(kept.map((k) => k.promise));
});

await test("get() never exposes timers or resolvers", () => {
  const m = new InteractionManager();
  const { id } = m.create({ sessionId: "s", message: "x" });
  const view = m.get(id);
  assert.deepStrictEqual(Object.keys(view).sort(), ["createdAt", "id", "kind", "message", "schema", "sessionId", "source"]);
  m.disposeAll();
});

console.log("\n📦 elicitation handler (safety rules)");

function handler({ hooks = {}, interactions, sessionId = "s", signal = null, timeoutMs } = {}) {
  const config = cfg(hooks);
  const seen = [];
  const fireHook = async (event, payload, opts = {}) => {
    seen.push({ event, payload });
    return fireHookEvent(event, payload, { config, cwd: tmp, ...opts });
  };
  return { fn: makeElicitationHandler({ interactions, sessionId, serverName: "srv", fireHook, signal, timeoutMs }), seen };
}

await test("a malformed request (no message) is DECLINED without prompting", async () => {
  const m = new InteractionManager();
  const { fn, seen } = handler({ interactions: m });
  const out = await fn({});
  assert.deepStrictEqual(out, { action: "decline" });
  assert.strictEqual(m.size, 0, "the user must never be prompted for a malformed request");
  assert.ok(seen.some((e) => e.event === "ElicitationResult"));
});

await test("a malformed requestedSchema is DECLINED", async () => {
  const m = new InteractionManager();
  const { fn } = handler({ interactions: m });
  assert.deepStrictEqual(await fn({ message: "hi", requestedSchema: "not-an-object" }), { action: "decline" });
  assert.strictEqual(m.size, 0);
});

await test("an Elicitation hook can DECLINE before the user is disturbed", async () => {
  const m = new InteractionManager();
  const { fn } = handler({
    interactions: m,
    hooks: { Elicitation: [{ hooks: [{ type: "command", command: "echo 'no prompts' >&2; exit 2" }] }] },
  });
  assert.deepStrictEqual(await fn({ message: "API key?" }), { action: "decline" });
  assert.strictEqual(m.size, 0, "a vetoed elicitation must never become a pending prompt");
});

await test("a hook CANNOT auto-accept on the user's behalf", async () => {
  const m = new InteractionManager();
  const json = JSON.stringify({ permissionDecision: "allow" });
  const { fn } = handler({
    interactions: m,
    hooks: { Elicitation: [{ hooks: [{ type: "command", command: `echo '${json}'` }] }] },
    timeoutMs: 80,
  });
  const out = await fn({ message: "API key?" });
  assert.strictEqual(out.action, "cancel", 'hook "allow" means ask the user, never answer for them');
});

await test("a real accept flows the user's content back to the server", async () => {
  const m = new InteractionManager();
  const { fn, seen } = handler({ interactions: m });
  const p = fn({ message: "Which branch?", requestedSchema: { type: "object", properties: { branch: { type: "string" } } } });
  await settle();
  const [pending] = m.listPending("s");
  assert.ok(pending, "an interaction should be waiting");
  m.respond(pending.id, { action: "accept", content: { branch: "main" } });
  assert.deepStrictEqual(await p, { action: "accept", content: { branch: "main" } });

  const result = seen.find((e) => e.event === "ElicitationResult").payload;
  assert.strictEqual(result.action, "accept");
  assert.strictEqual(result.hasContent, true);
  assert.strictEqual(result.content, undefined, "the user's answer must NOT be copied into the hook payload");
});

await test("a timeout returns cancel to the server (no hang, no accept)", async () => {
  const m = new InteractionManager();
  const { fn } = handler({ interactions: m, timeoutMs: 80 });
  assert.deepStrictEqual(await fn({ message: "slow" }), { action: "cancel" });
});

await test("a decline returns decline with no content", async () => {
  const m = new InteractionManager();
  const { fn } = handler({ interactions: m });
  const p = fn({ message: "secret?" });
  await settle();
  m.respond(m.listPending("s")[0].id, { action: "decline" });
  assert.deepStrictEqual(await p, { action: "decline" });
});

console.log("\n📦 protocol (real MCP server issuing elicitation/create)");

// A real stdio server that initiates elicitation and records the reply it got.
const SERVER = `
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, clientCaps: msg.params.capabilities } });
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "noop", inputSchema: { type: "object", properties: {} } }] } });
    } else if (msg.method === "askUser") {
      // Fixture trigger: server initiates elicitation with a known id.
      send({ jsonrpc: "2.0", id: 7001, method: "elicitation/create", params: { message: "Which environment?", requestedSchema: { type: "object", properties: { env: { type: "string" } } } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { started: true } });
    } else if (msg.id === 7001) {
      // The client's REPLY to our elicitation — echo it back for assertions.
      send({ jsonrpc: "2.0", id: 9999, method: "recordedReply", params: msg });
    } else if (msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } });
    }
  }
});
`;
const serverPath = path.join(tmp, "elicit-server.mjs");
await fs.writeFile(serverPath, SERVER, "utf-8");

await test("the client advertises the elicitation capability only when enabled", async () => {
  const m = new InteractionManager();
  const withCap = spawnMcpServer({ type: "stdio", command: process.execPath, args: [serverPath] }, tmp, {
    onElicitation: handler({ interactions: m }).fn,
  });
  const init = await withCap.start();
  assert.deepStrictEqual(init.clientCaps.elicitation, {}, "capability must be advertised");
  withCap.close();

  const without = spawnMcpServer({ type: "stdio", command: process.execPath, args: [serverPath] }, tmp);
  const init2 = await without.start();
  assert.strictEqual(init2.clientCaps.elicitation, undefined, "must not advertise what we cannot do");
  without.close();
});

await test("a server's elicitation/create reaches the user and the reply correlates by id", async () => {
  const m = new InteractionManager();
  const replies = [];
  const client = spawnMcpServer({ type: "stdio", command: process.execPath, args: [serverPath] }, tmp, {
    onElicitation: handler({ interactions: m }).fn,
  });
  // Capture the server's echo of our reply.
  const origHandle = client._handleLine.bind(client);
  client._handleLine = (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.method === "recordedReply") { replies.push(msg.params); return; }
    } catch { /* fall through */ }
    origHandle(line);
  };

  try {
    await client.start();
    await client._request("askUser", {});
    await settle(150);

    const [pending] = m.listPending("s");
    assert.ok(pending, "the elicitation must surface as a pending interaction");
    assert.strictEqual(pending.message, "Which environment?");
    assert.strictEqual(pending.source, "mcp:srv");

    m.respond(pending.id, { action: "accept", content: { env: "staging" } });
    await settle(150);

    assert.strictEqual(replies.length, 1, "the server must receive exactly one reply");
    assert.strictEqual(replies[0].id, 7001, "reply must correlate to the server's request id");
    assert.strictEqual(replies[0].result.action, "accept");
    assert.deepStrictEqual(replies[0].result.content, { env: "staging" });
  } finally { client.close(); }
});

await test("a server elicitation with NO handler gets a clean error, never a hang", async () => {
  const replies = [];
  const client = spawnMcpServer({ type: "stdio", command: process.execPath, args: [serverPath] }, tmp);
  const origHandle = client._handleLine.bind(client);
  client._handleLine = (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.method === "recordedReply") { replies.push(msg.params); return; }
    } catch { /* fall through */ }
    origHandle(line);
  };
  try {
    await client.start();
    await client._request("askUser", {});
    await settle(150);
    assert.strictEqual(replies.length, 1);
    assert.ok(/not enabled/i.test(replies[0].error?.message || ""), `expected an error reply, got ${JSON.stringify(replies[0])}`);
  } finally { client.close(); }
});

closeMcpPool();
await fs.rm(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
