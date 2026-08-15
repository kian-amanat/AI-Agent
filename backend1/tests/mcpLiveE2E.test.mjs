/**
 * tests/mcpLiveE2E.test.mjs
 *
 *   npm run test:e2e          → runs for real; FAILS loudly with no credential
 *   npm test                  → sets KODO_E2E_OPTIONAL=1, so it SKIPS instead
 *
 * The only test that proves the whole chain is real:
 *
 *   real LLM → real Kodo agent loop → real MCP discovery → real tool call
 *   → real MCP server (child process) → real tool result → real LLM
 *   continuation → persisted turn_events → reconstructed conversation
 *
 * Nothing here is mocked. The agent loop decides on its own to call the tool;
 * the test never invokes it. The MCP server holds a cryptographically random
 * secret that appears NOWHERE in the prompt, so the final answer can only
 * contain it if the full chain actually executed.
 *
 * PROVIDERS — KODO_E2E_PROVIDER is explicit and disables all inference. Use it
 * for any OpenAI-compatible gateway: those issue `sk-…`-shaped keys but are
 * neither OpenAI nor Anthropic, so guessing from the key prefix would POST to
 * the wrong host.
 *
 *   # Custom OpenAI-compatible endpoint (GapGPT, OpenRouter, vLLM, Ollama…)
 *   KODO_E2E_PROVIDER=openai-compatible \
 *   KODO_E2E_API_KEY="$YOUR_KEY" \
 *   KODO_E2E_BASE_URL="https://api.gapgpt.app/v1" \
 *   KODO_E2E_MODEL="gapgpt-qwen-3.6" \
 *   npm run test:e2e
 *
 *   # Anthropic
 *   KODO_E2E_PROVIDER=anthropic KODO_E2E_API_KEY="$KEY" npm run test:e2e
 *
 *   # Official OpenAI
 *   KODO_E2E_PROVIDER=openai KODO_E2E_API_KEY="$KEY" npm run test:e2e
 *
 * Omitting KODO_E2E_PROVIDER falls back to inference (sk-ant- → Anthropic,
 * otherwise OpenAI) and then to Kodo's own data/settings.json. Credentials are
 * never printed, never written, and never committed.
 *
 * A pre-flight proves the provider is reachable, the credential and model are
 * accepted, and the model genuinely EMITS OpenAI-format tool calls — the hard
 * requirement for MCP. If any of those fail the run exits non-zero with a
 * precise diagnostic; it never degrades into a false pass.
 */

import assert from "assert";
import crypto from "crypto";
import path from "path";
import fs from "fs/promises";
import os from "os";

// ── Credential resolution ────────────────────────────────────────────────────

// Kodo's own local config (data/settings.json) is a legitimate credential
// source — it is what resolveCreds() falls back to at runtime — so the harness
// reads it too rather than forcing duplicate env setup. Env always wins.
async function readLocalSettings() {
  try {
    const raw = await (await import("fs/promises")).readFile(
      new URL("../data/settings.json", import.meta.url), "utf-8",
    );
    return JSON.parse(raw);
  } catch { return {}; }
}
const LOCAL = await readLocalSettings();

const RAW_KEY = process.env.KODO_E2E_API_KEY
  || process.env.OPENAI_API_KEY
  || process.env.ANTHROPIC_API_KEY
  || LOCAL.textApiKey || LOCAL.apiKey || "";
// "dummy" is what the unit suites export to satisfy client construction; it is
// not a usable credential and must never be mistaken for one.
const API_KEY = RAW_KEY === "dummy" ? "" : RAW_KEY;
const OPTIONAL = process.env.KODO_E2E_OPTIONAL === "1";

// ── Provider selection ───────────────────────────────────────────────────────
// EXPLICIT WINS. KODO_E2E_PROVIDER disables all inference, because guessing
// from a key prefix is wrong for OpenAI-compatible gateways: GapGPT, OpenRouter
// and friends issue `sk-…`-shaped keys but are neither OpenAI nor Anthropic,
// and inferring "openai" would silently POST to the wrong host.
//   openai-compatible → any custom endpoint (GapGPT, OpenRouter, vLLM, Ollama…)
//   anthropic         → api.anthropic.com
//   openai            → api.openai.com
const EXPLICIT_PROVIDER = (process.env.KODO_E2E_PROVIDER || "").trim().toLowerCase();
const VALID_PROVIDERS = new Set(["openai-compatible", "anthropic", "openai"]);
if (EXPLICIT_PROVIDER && !VALID_PROVIDERS.has(EXPLICIT_PROVIDER)) {
  console.error(`\n❌ Unknown KODO_E2E_PROVIDER "${EXPLICIT_PROVIDER}". Use one of: ${[...VALID_PROVIDERS].join(", ")}\n`);
  process.exit(1);
}

// A configured base URL that is NOT one of the two first-party hosts means an
// OpenAI-COMPATIBLE gateway, and inference has to say so.
//
// Without this, an environment holding a GapGPT key in OPENAI_API_KEY and
// `OPENAI_BASE_URL=https://api.gapgpt.app/v1` inferred plain "openai", ignored
// the base URL entirely, and POSTed that key to api.openai.com — which
// naturally returned 401. The suite then reported "the API key was rejected",
// which is true and completely misleading: the key is fine, it was simply sent
// to the wrong company. The credential fallback already reads OPENAI_API_KEY,
// so it must read OPENAI_BASE_URL from the same place or the pair is split
// across two different providers.
const CONFIGURED_BASE = process.env.KODO_E2E_BASE_URL
  || LOCAL.textBaseUrl || LOCAL.baseUrl || process.env.OPENAI_BASE_URL || "";
const IS_FIRST_PARTY_BASE = !CONFIGURED_BASE
  || /(^|\/\/)(api\.)?openai\.com/i.test(CONFIGURED_BASE)
  || /anthropic\.com/i.test(CONFIGURED_BASE);

const INFERRED = /anthropic/i.test(CONFIGURED_BASE)
  || (!CONFIGURED_BASE && /^sk-ant-/.test(API_KEY))
  || (!process.env.KODO_E2E_API_KEY && !process.env.OPENAI_API_KEY && !!process.env.ANTHROPIC_API_KEY)
  ? "anthropic"
  : IS_FIRST_PARTY_BASE ? "openai" : "openai-compatible";

const PROVIDER = EXPLICIT_PROVIDER || INFERRED;
const IS_ANTHROPIC = PROVIDER === "anthropic";

// An explicit provider requires an explicit base URL unless it is one of the
// two first-party hosts — there is no sane default for "some custom endpoint".
const DEFAULT_BASE = IS_ANTHROPIC
  ? `${(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "")}/v1`
  : PROVIDER === "openai"
    ? "https://api.openai.com/v1"
    : (LOCAL.textBaseUrl || LOCAL.baseUrl || process.env.OPENAI_BASE_URL || "");

const BASE_URL = (process.env.KODO_E2E_BASE_URL || DEFAULT_BASE || "").replace(/\/$/, "");
const MODEL = process.env.KODO_E2E_MODEL
  || (IS_ANTHROPIC ? "claude-sonnet-5"
    : PROVIDER === "openai" ? "gpt-4o-mini"
      : (LOCAL.textModel || LOCAL.model || ""));

const HOWTO = [
  "  Supply credentials via the environment (never hardcoded, never committed):",
  "",
  "    # Custom OpenAI-compatible endpoint (GapGPT, OpenRouter, vLLM, …)",
  "    KODO_E2E_PROVIDER=openai-compatible \\",
  '    KODO_E2E_API_KEY="$YOUR_KEY" \\',
  '    KODO_E2E_BASE_URL="https://api.gapgpt.app/v1" \\',
  '    KODO_E2E_MODEL="gapgpt-qwen-3.6" \\',
  "    npm run test:e2e",
  "",
  "    # Anthropic",
  '    KODO_E2E_PROVIDER=anthropic KODO_E2E_API_KEY="$KEY" npm run test:e2e',
  "",
  "    # Official OpenAI",
  '    KODO_E2E_PROVIDER=openai KODO_E2E_API_KEY="$KEY" npm run test:e2e',
].join("\n");

if (API_KEY && (!BASE_URL || !MODEL)) {
  console.error(`\n❌ Incomplete provider configuration for KODO_E2E_PROVIDER="${PROVIDER}".`);
  console.error(`   base URL: ${BASE_URL || "(missing — set KODO_E2E_BASE_URL)"}`);
  console.error(`   model:    ${MODEL || "(missing — set KODO_E2E_MODEL)"}\n`);
  console.error(HOWTO + "\n");
  process.exit(1);
}

if (!API_KEY) {
  if (OPTIONAL) {
    // Aggregate `npm test` run: opt-in, so skipping is intended — but say
    // plainly that nothing was verified.
    console.log("\n⏭  SKIPPED — LIVE MCP E2E did not run (no credential).");
    console.log("   NOT a verification: the live chain remains unproven.\n");
    console.log(HOWTO + "\n");
    process.exit(0);
  }
  console.error("\n❌ LIVE MCP E2E CANNOT RUN — no API credential found.\n");
  console.error(HOWTO + "\n");
  process.exit(1); // a missing key must never look green
}

// ── Pre-flight: prove the provider can do what MCP requires ──────────────────
// Runs BEFORE any MCP work so a credential/model/tool-calling problem reports
// as exactly that, instead of surfacing later as a confusing "model didn't pick
// the tool" failure. Anthropic-native routing is exercised by the agent loop
// itself, so the probe only applies to the OpenAI-compatible wire format.
async function preflight() {
  const headers = { "content-type": "application/json", authorization: `Bearer ${API_KEY}` };
  const out = { reachable: false, modelAccepted: false, toolCalling: false, detail: "" };

  const probeTools = [{
    type: "function",
    function: {
      name: "mcp__deploy__get_deploy_token",
      description: "Returns the current deploy token for this project. Only obtainable from this tool.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  }];

  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST", headers,
      body: JSON.stringify({
        model: MODEL, tools: probeTools, tool_choice: "auto", stream: true, max_tokens: 256,
        messages: [
          { role: "system", content: "Use the provided tools when they can answer the question. Never guess a value a tool can supply." },
          { role: "user", content: "What is the current deploy token for this project?" },
        ],
      }),
    });
  } catch (err) {
    out.detail = `cannot reach ${BASE_URL} — ${err?.message || err}`;
    return out;
  }

  out.reachable = true; // an HTTP response of any status means the host answered

  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    if (res.status === 401 || res.status === 403) {
      out.detail = `HTTP ${res.status} — the API key was rejected by ${BASE_URL}. It is missing, expired, or not valid for this endpoint.\n     provider said: ${body}`;
    } else if (res.status === 404 || /model/i.test(body)) {
      out.detail = `HTTP ${res.status} — the endpoint rejected model "${MODEL}".\n     provider said: ${body}`;
    } else {
      out.detail = `HTTP ${res.status} from ${BASE_URL}\n     provider said: ${body}`;
    }
    return out;
  }

  out.modelAccepted = true;

  // Does it actually EMIT an OpenAI-shaped tool call over the stream? This is
  // the hard gate: a model that only talks about the tool cannot drive MCP.
  const raw = await res.text();
  const names = new Set();
  let text = "";
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const d = line.slice(5).trim();
    if (!d || d === "[DONE]") continue;
    try {
      const delta = JSON.parse(d).choices?.[0]?.delta;
      for (const tc of delta?.tool_calls || []) if (tc.function?.name) names.add(tc.function.name);
      if (typeof delta?.content === "string") text += delta.content;
    } catch { /* ignore keep-alive / non-JSON frames */ }
  }

  out.toolCalling = names.has("mcp__deploy__get_deploy_token");
  if (!out.toolCalling) {
    out.detail = names.size
      ? `the model emitted tool calls (${[...names].join(", ")}) but not the offered MCP tool`
      : `model "${MODEL}" did not emit any OpenAI-format tool call. It replied with text instead: ${JSON.stringify(text.slice(0, 160))}`;
  }
  return out;
}

console.log("\nLIVE MCP E2E — provider pre-flight");
console.log(`Provider: ${PROVIDER}${EXPLICIT_PROVIDER ? " (explicit)" : " (inferred)"}`);
console.log(`Base URL: ${BASE_URL}`);
console.log(`Model:    ${MODEL}\n`);

const pre = await preflight();
console.log(`  ${pre.reachable ? "✓" : "✗"} endpoint reachable`);
console.log(`  ${pre.modelAccepted ? "✓" : "✗"} credential + model accepted`);
console.log(`  ${pre.toolCalling ? "✓" : "✗"} OpenAI-compatible tool calling supported`);
if (pre.detail) console.log(`\n     ${pre.detail}`);

if (!pre.reachable || !pre.modelAccepted || !pre.toolCalling) {
  console.error("\n❌ LIVE MCP E2E: FAIL — pre-flight did not pass, so the MCP chain was NOT exercised.");
  console.error("   This is NOT a pass and NOT a skip: the provider could not meet the");
  console.error("   preconditions the MCP flow requires (reachable + authorized + tool calling).\n");
  console.error(HOWTO + "\n");
  process.exit(1);
}

// ── Real MCP server (child process, real stdio JSON-RPC) ─────────────────────

const SERVER_SECRET = `kdp_${crypto.randomBytes(16).toString("hex")}`;
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-live-e2e-"));
const hitLog = path.join(workspace, "server-hits.log");
const serverPath = path.join(workspace, "deploy-server.mjs");

// The secret is injected into the SERVER only. It never touches the prompt.
await fs.writeFile(serverPath, `
import fs from "fs";
const SECRET = ${JSON.stringify(SERVER_SECRET)};
const HITS = ${JSON.stringify(hitLog)};
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
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "deploy", version: "1" } } });
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{
        name: "get_deploy_token",
        description: "Returns the current deploy token for this project. The token is only obtainable from this tool.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }] } });
    } else if (msg.method === "tools/call") {
      // Durable proof the real server process was actually reached.
      fs.appendFileSync(HITS, JSON.stringify({ tool: msg.params.name, at: Date.now() }) + "\\n");
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: SECRET }] } });
    } else if (msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } });
    }
  }
});
`, "utf-8");

await fs.mkdir(path.join(workspace, ".kodo"), { recursive: true });
await fs.writeFile(
  path.join(workspace, ".kodo", "settings.json"),
  JSON.stringify({ mcpServers: { deploy: { command: process.execPath, args: [serverPath] } } }, null, 2),
  "utf-8",
);

// ── Wire the REAL agent loop + REAL persistence ──────────────────────────────

// config/openai.mjs builds a module-level client at import time and throws
// without OPENAI_API_KEY in the environment. The agent loop's real credential
// arrives via modelRoute below; this only satisfies that eager construction so
// the import doesn't fail when the key was supplied as KODO_E2E_API_KEY.
if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = API_KEY;

const { agentLoopNode } = await import("../agents/nodes/agent_loop.mjs");
const { closeMcpPool } = await import("../services/mcpTools.mjs");
const db = await import("../db.mjs");
const { buildConversationFromEvents } = await import("../services/conversationStore.mjs");

const sessionId = `sess_e2e_${Date.now()}`;
const requestId = `req_e2e_${Date.now()}`;
const userId = null;
db.createSession(sessionId, userId, "live mcp e2e");
db.clearTurnEvents(sessionId, userId);

const progress = [];
const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `\n      ${detail}`}`);
};

console.log("\nLIVE MCP E2E");
console.log(`Provider: ${PROVIDER}`);
console.log(`Model:    ${MODEL}`);
console.log(`Base URL: ${BASE_URL}`);
console.log(`Secret:   ${SERVER_SECRET.slice(0, 8)}… (server-side only, never in the prompt)\n`);

// The task requires the tool: the token is unknowable without calling it.
const USER_TASK =
  "What is the current deploy token for this project? " +
  "Use the available tooling to look it up, then reply with the token value verbatim. Do not guess.";

assert.ok(!USER_TASK.includes(SERVER_SECRET), "the prompt must never contain the secret");

let finalAnswer = "";
let loopError = null;

try {
  const out = await agentLoopNode({
    workspacePath: workspace,
    userMessage: USER_TASK,
    modelRoute: { ok: true, apiKey: API_KEY, model: MODEL, baseUrl: BASE_URL },
    visionRoute: {},
    sessionId,
    requestId,
    permissionMode: "auto",
    emit: (e) => { if (e?.type === "progress") progress.push(String(e.message || "")); },
    // Real persistence: the same recorder the route installs.
    recordEvent: (event) => {
      try { db.appendTurnEvent({ ...event, sessionId, userId, requestId }); }
      catch (err) { console.warn("[turn_events] append failed:", err.message); }
    },
  });
  finalAnswer = String(out?.finalAnswer || "");
} catch (err) {
  loopError = err;
}

// ── Assertions over the whole chain ──────────────────────────────────────────

check("real LLM request succeeded", !loopError, loopError ? String(loopError.message || loopError) : "");

const events = db.getTurnEvents(sessionId, userId);
const assistantCalls = events
  .filter((e) => e.kind === "assistant" && e.tool_calls)
  .flatMap((e) => { try { return JSON.parse(e.tool_calls) || []; } catch { return []; } });
const mcpCall = assistantCalls.find((c) => c?.function?.name === "mcp__deploy__get_deploy_token");
const toolEvents = events.filter((e) => e.kind === "tool");
const mcpToolEvent = toolEvents.find((e) => e.tool_name === "mcp__deploy__get_deploy_token");

check(
  "MCP tool exposed to the model",
  progress.some((m) => /MCP: \d+ tool/.test(m)),
  `discovery progress not observed; saw: ${progress.slice(0, 4).join(" | ") || "(none)"}`,
);

check(
  "model selected the MCP tool (not invoked by the test)",
  !!mcpCall,
  `tools the model called: ${assistantCalls.map((c) => c?.function?.name).join(", ") || "(none)"}`,
);

let hits = "";
try { hits = await fs.readFile(hitLog, "utf-8"); } catch { /* never written */ }
check(
  "real MCP server process received the call",
  /"tool":"get_deploy_token"/.test(hits),
  "the server's hit log is empty — the child process was never reached",
);

check(
  "MCP result returned the server secret through Kodo",
  !!mcpToolEvent && String(mcpToolEvent.content || "").includes(SERVER_SECRET),
  mcpToolEvent ? "tool event recorded but secret absent" : "no MCP tool result event recorded",
);

check(
  "model received the result and continued",
  !!mcpToolEvent && events.some((e) => e.kind === "assistant" && e.id > mcpToolEvent.id),
  "no assistant turn followed the tool result",
);

check(
  "final answer contains the server secret",
  finalAnswer.includes(SERVER_SECRET),
  `final answer: ${finalAnswer.slice(0, 200) || "(empty)"}`,
);

// ── Persistence: Item 1 (memory) proven together with Item 2 (MCP) ───────────

const replayed = buildConversationFromEvents(db.getTurnEvents(sessionId, userId));
const replayedCallIds = new Set(
  replayed.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
);
const replayedMcpCall = replayed.some((m) =>
  (m.tool_calls || []).some((tc) => tc.function?.name === "mcp__deploy__get_deploy_token"));
const replayedSecret = replayed.some((m) => String(m.content || "").includes(SERVER_SECRET));
const pairingValid = replayed.every((m) => (m.tool_calls || []).every((tc) => replayedCallIds.has(tc.id)));
const pairedInDb = !!mcpCall && !!mcpToolEvent && mcpToolEvent.tool_call_id === mcpCall.id;

check("tool call + result persisted and correctly paired in turn_events", pairedInDb,
  `call id=${mcpCall?.id || "?"} result tool_call_id=${mcpToolEvent?.tool_call_id || "?"}`);
check("MCP event survives conversation reconstruction", replayedMcpCall && replayedSecret,
  `call=${replayedMcpCall} secret=${replayedSecret}`);
check("reconstructed conversation is provider-legal (no dangling call)", pairingValid);

// ── Teardown + verdict ───────────────────────────────────────────────────────

closeMcpPool();
db.clearTurnEvents(sessionId, userId);
db.deleteSession(sessionId, userId);
await fs.rm(workspace, { recursive: true, force: true });

const failedChecks = results.filter((r) => !r.ok);
console.log(`\n${results.length - failedChecks.length}/${results.length} checks passed`);
if (failedChecks.length) {
  console.error("\n❌ LIVE MCP E2E: FAIL — the chain is NOT verified.\n");
  process.exit(1);
}
console.log("\n✅ LIVE MCP E2E: PASS — real model called a real MCP server and used its result.\n");
process.exit(0);
