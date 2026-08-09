/**
 * tests/transportReliability.test.mjs
 * Run with: node tests/transportReliability.test.mjs
 *
 * The retry classifier and the HTTP connection-pool configuration. Offline; no
 * provider is contacted.
 *
 * These exist because of a concrete, expensive failure: a 15-iteration
 * benchmark run died on a single dropped socket. The OpenAI SDK reports every
 * transport failure as the bare string "Connection error." and hides the real
 * reason (UND_ERR_SOCKET / "other side closed") in `err.cause`. The agent
 * loop's retry-with-backoff matched only `err.message`, so it classified a
 * recoverable blip as permanent and never retried once — the run reported
 * "provider failed after 1 attempt(s)".
 *
 * The other half of the bug is the pool: an idle socket must be retired by US
 * before the gateway closes it, or the next request grabs a dead one.
 */

import assert from "assert";
import { readFileSync } from "fs";
import { isTransientTransportError, describeErrorChain, LLM_DISPATCHER_CONFIG, supportsEnableThinking } from "../services/agentChat.mjs";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (err) { console.error(`  ❌ ${name}\n     ${err.message}`); failed++; }
}

/** Shapes the OpenAI SDK actually produces. */
const apiConnectionError = (cause) => Object.assign(new Error("Connection error."), { name: "APIConnectionError", cause });
const httpError = (status, message) => Object.assign(new Error(message), { status });

console.log("\n══ TRANSIENT: the pipe broke ═════════════════════════════════");

test('the SDK\'s bare "Connection error." is transient', () => {
  assert.strictEqual(isTransientTransportError(apiConnectionError()), true);
});

test("UND_ERR_SOCKET in err.cause is transient", () => {
  assert.strictEqual(isTransientTransportError(apiConnectionError(Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }))), true);
});

test('"other side closed" nested two levels deep is transient', () => {
  const inner = new Error("other side closed");
  const mid = Object.assign(new Error("fetch failed"), { cause: inner });
  assert.strictEqual(isTransientTransportError(apiConnectionError(mid)), true);
});

test("ECONNRESET is transient", () => {
  assert.strictEqual(isTransientTransportError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })), true);
});

test("EPIPE is transient", () => {
  assert.strictEqual(isTransientTransportError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })), true);
});

test("socket hang up is transient", () => {
  assert.strictEqual(isTransientTransportError(new Error("socket hang up")), true);
});

test("fetch failed is transient", () => {
  assert.strictEqual(isTransientTransportError(new Error("fetch failed")), true);
});

test("5xx and 429 remain transient (existing behaviour preserved)", () => {
  for (const s of [500, 502, 503, 504, 529, 429, 408]) {
    assert.strictEqual(isTransientTransportError(httpError(s, `HTTP ${s}`)), true, `status ${s}`);
  }
});

console.log("\n══ PERMANENT: the server refused ═════════════════════════════");

test("401 unauthorized is NOT transient", () => {
  assert.strictEqual(isTransientTransportError(httpError(401, "Unauthorized")), false);
});

test("403 is NOT transient", () => {
  assert.strictEqual(isTransientTransportError(httpError(403, "Forbidden")), false);
});

test("a quota failure is NOT transient", () => {
  // The exact shape this provider returns; it must never be retried into the ground.
  assert.strictEqual(
    isTransientTransportError(httpError(403, "pre-consume quota failed, remaining user quota: $0.0017")),
    false
  );
  assert.strictEqual(isTransientTransportError(new Error("insufficient user quota")), false);
});

test("an invalid-request error is NOT transient", () => {
  assert.strictEqual(isTransientTransportError(httpError(400, "invalid_request_error: bad parameter")), false);
});

test("an unknown model is NOT transient", () => {
  assert.strictEqual(isTransientTransportError(httpError(404, "The model `nope` does not exist")), false);
});

test("a permanent STATUS beats transient-looking wording", () => {
  // A 403 whose body happens to mention a connection must still not be retried.
  assert.strictEqual(isTransientTransportError(httpError(403, "quota exceeded; connection error while billing")), false);
});

test("an ordinary model error is NOT transient", () => {
  assert.strictEqual(isTransientTransportError(new Error("context_length_exceeded")), false);
});

console.log("\n══ the cause walk is bounded ═════════════════════════════════");

test("a cyclic cause chain terminates", () => {
  const a = new Error("a"); const b = new Error("b");
  a.cause = b; b.cause = a;
  const { text } = describeErrorChain(a);
  assert.ok(typeof text === "string");
});

test("describeErrorChain surfaces the status from anywhere in the chain", () => {
  assert.strictEqual(describeErrorChain(apiConnectionError(httpError(503, "upstream"))).status, 503);
});

console.log("\n══ MODEL CAPABILITY: enable_thinking ═════════════════════════");

// `enable_thinking` is a Qwen-family request extension. OpenAI-family models do
// not ignore it — they reject the whole request with
// `400 Unrecognized request argument supplied: extra_body`, which is permanent
// and killed a benchmark repeat the moment Kodo was pointed at gpt-4.1-nano.
test("Qwen-family models accept enable_thinking", () => {
  for (const m of ["gapgpt-qwen-3.6", "qwen3-coder", "Qwen/Qwen3.5-35B-A3B-FP8", "qwen3-235b-a22b"]) {
    assert.strictEqual(supportsEnableThinking(m), true, m);
  }
});

test("adjacent providers that share the extension are allowed", () => {
  for (const m of ["deepseek-v4-flash", "glm-4", "kimi-k2", "minimax-m2", "hunyuan-large"]) {
    assert.strictEqual(supportsEnableThinking(m), true, m);
  }
});

test("gpt-4.1-nano NEVER receives enable_thinking", () => {
  assert.strictEqual(supportsEnableThinking("gpt-4.1-nano"), false,
    "this exact model is what the 400 was observed against");
});

test("no OpenAI-family model receives it", () => {
  for (const m of ["gpt-4o-mini", "gpt-4.1-mini", "gpt-5-nano", "o1", "o3-mini", "gpt-5.1-codex-mini"]) {
    assert.strictEqual(supportsEnableThinking(m), false, m);
  }
});

test("other vendors do not receive it either", () => {
  for (const m of ["claude-3-5-haiku-20241022", "gemini-2.5-flash", "grok-3-mini", "llama-3.1-70b"]) {
    assert.strictEqual(supportsEnableThinking(m), false, m);
  }
});

test("an unknown or empty model defaults to NOT sending it", () => {
  // Allow-list, not deny-list: omitting the parameter costs a slower answer,
  // sending it wrongly is a hard 400 that ends the run.
  for (const m of ["some-future-model", "", null, undefined]) {
    assert.strictEqual(supportsEnableThinking(m), false, String(m));
  }
});

console.log("\n══ CLEAN RETRY SCOPING ═══════════════════════════════════════");

// Mirrors the predicate in openaiChat. If these drift, the retry either stops
// firing or starts firing on errors that must never be retried.
const rejectsExtraBody = (err) =>
  /extra_body|unrecognized request argument|unknown (?:request )?(?:argument|parameter)|unexpected keyword/i
    .test(String(err?.message ?? err));

test("the observed 400 triggers exactly one clean retry", () => {
  assert.strictEqual(rejectsExtraBody(new Error("400 Unrecognized request argument supplied: extra_body")), true);
});

test("other phrasings of the same rejection are covered", () => {
  for (const m of ["unknown parameter: extra_body", "unexpected keyword argument", "Unknown request argument"]) {
    assert.strictEqual(rejectsExtraBody(new Error(m)), true, m);
  }
});

test("an ordinary 400 does NOT trigger the clean retry", () => {
  for (const m of ["400 invalid_request_error: bad parameter", "400 context_length_exceeded", "400 messages must not be empty"]) {
    assert.strictEqual(rejectsExtraBody(new Error(m)), false, m);
  }
});

test("auth and quota failures trigger neither retry path", () => {
  for (const [msg, status] of [["Unauthorized", 401], ["Forbidden", 403], ["insufficient user quota", 403]]) {
    const err = Object.assign(new Error(msg), { status });
    assert.strictEqual(rejectsExtraBody(err), false, `${msg}: clean retry`);
    assert.strictEqual(isTransientTransportError(err), false, `${msg}: transient retry`);
  }
});

test("transient network failures keep their existing retry behaviour", () => {
  assert.strictEqual(isTransientTransportError(Object.assign(new Error("Connection error."), { name: "APIConnectionError" })), true);
  assert.strictEqual(isTransientTransportError(Object.assign(new Error("x"), { status: 429 })), true);
});

test("the clean retry is issued once and cannot recurse", () => {
  // Structural: the retry calls nonStreamingCall(true), whose own catch does
  // not re-enter it, so a provider that rejects both shapes fails cleanly.
  const src = readFileSync(new URL("../services/agentChat.mjs", import.meta.url), "utf-8");
  assert.ok(!/nonStreamingCall\(true\)[\s\S]{0,300}nonStreamingCall\(true\)/.test(src),
    "a retry that can re-enter itself would loop on a provider that rejects both shapes");
});

console.log("\n══ CONNECTION POOL ═══════════════════════════════════════════");

test("idle pooled sockets are retired before a gateway is likely to close them", () => {
  const c = LLM_DISPATCHER_CONFIG;
  assert.strictEqual(c.keepAliveTimeout, 4_000);
  assert.strictEqual(c.keepAliveMaxTimeout, 10_000, "an idle socket must not be reusable for minutes");
  assert.ok(c.keepAliveMaxTimeout <= 30_000, "too long: this is what let a dead socket back into the pool");
  assert.ok(c.keepAliveTimeoutThreshold > 0, "a safety margin is needed against the server's advertised timeout");
});

test("in-flight request timeouts are untouched and still exceed the SDK ceiling", () => {
  const c = LLM_DISPATCHER_CONFIG;
  assert.strictEqual(c.headersTimeout, 900_000);
  assert.strictEqual(c.bodyTimeout, 900_000);
  assert.ok(c.headersTimeout > 600_000, "undici must not out-time the SDK's own 600s thinking ceiling");
});

test("connection reuse is not disabled outright", () => {
  assert.ok(LLM_DISPATCHER_CONFIG.keepAliveTimeout > 0, "reuse within a burst is still wanted");
});

console.log(`\n${"═".repeat(62)}`);
console.log(`  transport reliability: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(62)}\n`);
process.exit(failed === 0 ? 0 : 1);
