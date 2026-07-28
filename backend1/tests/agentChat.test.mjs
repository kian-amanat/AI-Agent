/**
 * tests/agentChat.test.mjs
 * Run with: node tests/agentChat.test.mjs
 *
 * Tests the request-shaping logic in services/agentChat.mjs — Anthropic
 * prompt-cache breakpoints and the explicit enable_thinking override for
 * OpenAI-compatible providers — by capturing the outgoing request instead
 * of making a real API call. No credentials needed.
 */

import assert from "assert";
import { chatWithTools } from "../services/agentChat.mjs";

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

function fakeAnthropicResponse() {
  return new Response(JSON.stringify({
    content: [{ type: "text", text: "ok" }],
    usage: { input_tokens: 10, output_tokens: 2 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

console.log("\n📦 agentChat — Anthropic prompt caching");

await test("system prompt is sent as a cache_control-marked block, not a plain string", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody;
  globalThis.fetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return fakeAnthropicResponse();
  };
  try {
    await chatWithTools({
      creds: { apiKey: "x", baseURL: "https://api.anthropic.com/v1", model: "claude-3-5-sonnet-20241022" },
      system: "you are a helpful agent",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(Array.isArray(capturedBody.system), "system should be an array of blocks, not a plain string");
  assert.strictEqual(capturedBody.system[0].text, "you are a helpful agent");
  assert.deepStrictEqual(capturedBody.system[0].cache_control, { type: "ephemeral" });
});

await test("the last tool definition gets the cache_control breakpoint (caches the whole tools array)", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody;
  globalThis.fetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return fakeAnthropicResponse();
  };
  try {
    await chatWithTools({
      creds: { apiKey: "x", baseURL: "https://api.anthropic.com/v1", model: "claude-3-5-sonnet-20241022" },
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "a", description: "a", parameters: {} } },
        { type: "function", function: { name: "b", description: "b", parameters: {} } },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.strictEqual(capturedBody.tools.length, 2);
  assert.strictEqual(capturedBody.tools[0].cache_control, undefined, "only the LAST tool should carry the breakpoint");
  assert.deepStrictEqual(capturedBody.tools[1].cache_control, { type: "ephemeral" });
});

console.log("\n📦 agentChat — explicit thinking override (OpenAI-compatible path)");

await test("thinking:false sends enable_thinking:false explicitly, even for a model name that doesn't look like a thinking model", async () => {
  let capturedParams;
  // Intercept via global fetch — robust across openai SDK versions, and
  // exactly what actually goes over the wire (what matters for this test).
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("chat/completions")) {
      capturedParams = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return originalFetch(url, opts);
  };
  try {
    await chatWithTools({
      creds: { apiKey: "x", baseURL: "https://example.com/v1", model: "qwen3.6" },
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      thinking: false,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(capturedParams, "expected a captured request body");
  assert.deepStrictEqual(capturedParams.extra_body, { enable_thinking: false });
});

console.log(`\n${"─".repeat(40)}\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
