/**
 * services/agentChat.mjs
 * One tool-calling chat interface, two protocols:
 *
 *   - OpenAI-compatible providers (OpenAI, Qwen, DeepSeek, GapGPT, Ollama…)
 *     via the openai SDK — including the streaming path for thinking models.
 *   - Anthropic via its NATIVE Messages API (tool use, not the OpenAI shim).
 *
 * The agent loop always stores conversation in OpenAI message format
 * ({role, content, tool_calls} / {role:"tool", tool_call_id, content}); this
 * module converts to/from Anthropic's block format at the boundary.
 *
 * Returns { message, usage } where message is OpenAI-shaped and usage is
 * normalized to { inputTokens, outputTokens }.
 */

import OpenAI from "openai";
import { Agent as UndiciAgent } from "undici";

const ANTHROPIC_VERSION = "2023-06-01";

// Node's built-in fetch (undici) enforces its OWN headersTimeout/bodyTimeout
// — 300s by default — completely independent of any timeout an HTTP client
// on top of it configures (e.g. the openai SDK's own `timeout` option below).
// A "thinking"/reasoning model can legitimately stay silent for several
// minutes generating a large tool call before emitting anything, since
// streaming only produces visible bytes for narrative text, not tool-call
// argument tokens. When that silence exceeds undici's default, IT tears the
// connection down first — surfacing as a raw, cryptic "BodyStreamBuffer was
// aborted" that looks like a hang or crash but is actually a timeout nobody
// configured on purpose. This dispatcher raises undici's own timeouts well
// above the longest timeout we intentionally configure elsewhere (the SDK's
// 600s "thinking model" ceiling), so THAT'S the one that ends up governing,
// predictably, instead of an invisible stricter one underneath it.
/**
 * Idle-socket policy, deliberately explicit.
 *
 * headersTimeout/bodyTimeout are about how long ONE in-flight request may stay
 * quiet. The keep-alive settings are the opposite problem: how long an IDLE
 * pooled socket may be reused afterwards. Undici defaults to honouring the
 * server's advertised `Keep-Alive: timeout=N` up to keepAliveMaxTimeout (600s),
 * so a gateway that advertises generously but closes early leaves a dead socket
 * in the pool. The next request grabs it and fails with UND_ERR_SOCKET
 * ("other side closed") — which is exactly the failure observed between agent
 * iterations separated by a slow shell command.
 *
 * Capping keepAliveMaxTimeout at 10s means a socket idle longer than that is
 * retired by us rather than reused into a close. Short enough to stay under any
 * plausible gateway idle timeout, long enough to keep reuse within a burst of
 * calls. The 2s threshold is undici's safety margin subtracted from whatever
 * the server advertises.
 */
export const LLM_DISPATCHER_CONFIG = Object.freeze({
  headersTimeout: 900_000,
  bodyTimeout: 900_000,
  keepAliveTimeout: 4_000,
  keepAliveMaxTimeout: 10_000,
  keepAliveTimeoutThreshold: 2_000,
});

const LLM_DISPATCHER = new UndiciAgent({ ...LLM_DISPATCHER_CONFIG });

/**
 * Does this model accept the `enable_thinking` request extension?
 *
 * Allow-list, not deny-list: an unknown model gets a clean request, because the
 * cost of omitting the parameter is that a hybrid model may think when we would
 * rather it did not (slower, pricier), while the cost of sending it wrongly is a
 * hard 400 that ends the run. Wrong-but-working beats wrong-and-fatal.
 */
export function supportsEnableThinking(model) {
  return /qwen|glm|deepseek|kimi|minimax|hunyuan|ernie|yi-|internlm/i.test(String(model || ""));
}

export function isAnthropicRoute(creds) {
  return /anthropic\.com/i.test(String(creds?.baseURL || "")) ||
         /^claude-/i.test(String(creds?.model || ""));
}

// ── Anthropic conversion ──────────────────────────────────────────────────────

// Prompt caching: Anthropic caches everything up to and including the last
// block marked cache_control, in the order tools → system → messages. The
// tool schemas and system prompt are IDENTICAL across every iteration of a
// single agent run (built once before the loop starts) — without a cache
// breakpoint, that's the same ~7-10k tokens of fixed overhead re-billed as
// fresh input on every one of up to 40 iterations. Marking the end of tools
// and the end of system caches both in one shot (cache order covers tools
// first), at zero behavior change — same request, same answer, just cheaper
// and faster on every cache hit within the 5-minute TTL.
function toAnthropicTools(tools = []) {
  const converted = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description || "",
    input_schema: t.function.parameters || { type: "object", properties: {} },
  }));
  if (converted.length) converted[converted.length - 1].cache_control = { type: "ephemeral" };
  return converted;
}

function toAnthropicSystem(system) {
  if (!system) return undefined;
  return [{ type: "text", text: String(system), cache_control: { type: "ephemeral" } }];
}

function toAnthropicMessages(messages = []) {
  const out = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: String(m.content ?? "") });
    } else if (m.role === "assistant") {
      const blocks = [];
      if (m.content) blocks.push({ type: "text", text: String(m.content) });
      for (const tc of m.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(tc.function.arguments || "{}"); } catch {}
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      if (blocks.length) out.push({ role: "assistant", content: blocks });
    } else if (m.role === "tool") {
      // Anthropic wants tool results as user-role tool_result blocks.
      // Merge consecutive tool results into one user turn.
      const block = {
        type: "tool_result",
        tool_use_id: m.tool_call_id,
        content: String(m.content ?? ""),
      };
      const last = out[out.length - 1];
      if (last?.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "tool_result") {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  return out;
}

function fromAnthropicResponse(data) {
  let content = "";
  const toolCalls = [];
  for (const block of data?.content || []) {
    if (block.type === "text") content += block.text;
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  return {
    role: "assistant",
    content: content || null,
    tool_calls: toolCalls.length ? toolCalls : undefined,
  };
}

async function anthropicChatNonStreaming({ creds, system, messages, tools, maxTokens, temperature, signal }) {
  const base = String(creds.baseURL || "https://api.anthropic.com/v1").replace(/\/+$/, "");
  const res = await fetch(`${base}/messages`, {
    method: "POST",
    signal,
    dispatcher: LLM_DISPATCHER,
    headers: {
      "content-type": "application/json",
      "x-api-key": creds.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: creds.model,
      max_tokens: maxTokens,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(system ? { system: toAnthropicSystem(system) } : {}),
      ...(tools?.length ? { tools: toAnthropicTools(tools) } : {}),
      messages: toAnthropicMessages(messages),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  return {
    message: fromAnthropicResponse(data),
    usage: {
      inputTokens: data?.usage?.input_tokens || 0,
      outputTokens: data?.usage?.output_tokens || 0,
    },
  };
}

// Parses Anthropic's SSE stream (content_block_start/delta/stop, message_delta,
// message_stop) and reassembles the same {message, usage} shape as the
// non-streaming call, calling onChunk with each text fragment as it arrives.
async function anthropicChatStreaming({ creds, system, messages, tools, maxTokens, temperature, signal, onChunk }) {
  const base = String(creds.baseURL || "https://api.anthropic.com/v1").replace(/\/+$/, "");
  const res = await fetch(`${base}/messages`, {
    method: "POST",
    signal,
    dispatcher: LLM_DISPATCHER,
    headers: {
      "content-type": "application/json",
      "x-api-key": creds.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: creds.model,
      max_tokens: maxTokens,
      stream: true,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(system ? { system: toAnthropicSystem(system) } : {}),
      ...(tools?.length ? { tools: toAnthropicTools(tools) } : {}),
      messages: toAnthropicMessages(messages),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }

  const blocks = []; // index → { type: "text"|"tool_use", text?, id?, name?, jsonBuf? }
  let inputTokens = 0;
  let outputTokens = 0;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      let evt;
      try { evt = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }

      switch (evt.type) {
        case "message_start":
          inputTokens = evt.message?.usage?.input_tokens || 0;
          break;
        case "content_block_start":
          blocks[evt.index] = evt.content_block?.type === "tool_use"
            ? { type: "tool_use", id: evt.content_block.id, name: evt.content_block.name, jsonBuf: "" }
            : { type: "text", text: "" };
          break;
        case "content_block_delta": {
          const b = blocks[evt.index];
          if (!b) break;
          if (evt.delta?.type === "text_delta") {
            b.text += evt.delta.text;
            onChunk?.(evt.delta.text);
          } else if (evt.delta?.type === "input_json_delta") {
            b.jsonBuf += evt.delta.partial_json || "";
          }
          break;
        }
        case "message_delta":
          outputTokens = evt.usage?.output_tokens || outputTokens;
          break;
        default:
          break;
      }
    }
  }

  let content = "";
  const toolCalls = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === "text") content += b.text;
    else if (b.type === "tool_use") {
      let input = {};
      try { input = b.jsonBuf ? JSON.parse(b.jsonBuf) : {}; } catch {}
      toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(input) } });
    }
  }

  return {
    message: { role: "assistant", content: content || null, tool_calls: toolCalls.length ? toolCalls : undefined },
    usage: { inputTokens, outputTokens },
  };
}

async function anthropicChat(args) {
  if (!args.onChunk) return anthropicChatNonStreaming(args);
  // Streaming is best-effort narration — any parse hiccup falls back to the
  // proven non-streaming call rather than losing the turn entirely.
  try {
    return await anthropicChatStreaming(args);
  } catch (err) {
    if (args.signal?.aborted) throw err;
    console.warn("[AgentChat] Anthropic streaming failed, falling back to non-streaming:", String(err?.message || err).slice(0, 160));
    return anthropicChatNonStreaming(args);
  }
}

// ── OpenAI-compatible path ────────────────────────────────────────────────────

async function openaiChat({ creds, system, messages, tools, maxTokens, temperature, signal, onChunk, thinking }) {
  const nameLooksLikeThinking = /thinking|r1\b|reasoner/i.test(creds.model);
  // `thinking` (explicit true/false from the call site) always wins over the
  // name-based guess. The guess exists for models that literally can't turn
  // reasoning off (o1, deepseek-reasoner) and need the longer timeout no
  // matter what; it CANNOT detect Qwen3-family models, which are hybrid —
  // capable of thinking regardless of what's in the name — and default
  // enable_thinking to true SERVER-SIDE if the request never mentions it.
  // Left unset (undefined), that default silently applies to every call,
  // billed at whatever premium the provider charges for reasoning output
  // tokens, for call sites (classification, tool execution, summarization)
  // that get zero benefit from it. Callers that know their call is purely
  // mechanical should pass `thinking:false` explicitly instead of relying on
  // the name guess.
  const wantsThinking = thinking !== undefined ? thinking : nameLooksLikeThinking;

  // `enable_thinking` is a Qwen-family (and adjacent Chinese-provider) request
  // extension. OpenAI-family models do not merely ignore it — they reject the
  // whole request with `400 Unrecognized request argument supplied: extra_body`,
  // which is not retryable and kills the run. That is not hypothetical: it
  // blocked a benchmark repeat the moment Kodo was pointed at gpt-4.1-nano
  // through the same OpenAI-compatible gateway that had been serving Qwen.
  //
  // So the parameter is sent only where it means something. Everywhere else the
  // request goes out clean, which is also the correct behaviour: there is no
  // server-side thinking default to suppress on a model that has no such mode.
  const extraBody = supportsEnableThinking(creds.model)
    ? (thinking !== undefined ? { enable_thinking: thinking }
      : (nameLooksLikeThinking ? { enable_thinking: true } : undefined))
    : undefined;

  const client = new OpenAI({
    apiKey: creds.apiKey,
    baseURL: creds.baseURL,
    timeout: wantsThinking ? 600_000 : 90_000,
    maxRetries: 0,
    fetchOptions: { dispatcher: LLM_DISPATCHER },
  });

  const fullMessages = [
    ...(system ? [{ role: "system", content: system }] : []),
    ...messages,
  ];

  // A plain (non-streamed) request. Also the fallback when streaming breaks:
  // some OpenAI-compatible providers return malformed SSE for tool-calling
  // turns, which the SDK surfaces as a JSON "Extra data" / SyntaxError. Rather
  // than fail the whole turn, we retry once without streaming.
  /** A 400 that names the offending extension, from any provider wording. */
  const rejectsExtraBody = (err) =>
    /extra_body|unrecognized request argument|unknown (?:request )?(?:argument|parameter)|unexpected keyword/i
      .test(String(err?.message ?? err));

  const nonStreamingCall = async (omitExtraBody = false) => {
    const response = await client.chat.completions.create({
      model: creds.model,
      messages: fullMessages,
      ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
      temperature,
      max_tokens: maxTokens,
      ...(extraBody && !omitExtraBody ? { extra_body: extraBody } : {}),
    }, { signal });
    return {
      message: response.choices?.[0]?.message || { role: "assistant", content: null },
      usage: {
        inputTokens: response.usage?.prompt_tokens || 0,
        outputTokens: response.usage?.completion_tokens || 0,
      },
    };
  };

  const looksLikeBadStream = (err) => {
    const msg = String(err?.message || err || "");
    return err?.name === "SyntaxError" ||
      /extra data|unexpected (token|non-whitespace|end of)|is not valid json|json parse|unterminated/i.test(msg);
  };

  // Stream whenever there's a live listener (agent narration) or the model
  // is a slow "thinking" model (streaming keeps gateways from cutting an
  // idle connection). Both paths share the same delta-accumulation logic —
  // the only difference is whether onChunk gets called per text fragment.
  if (wantsThinking || onChunk) {
    try {
      let contentBuf = "";
      const toolCallBufs = {}; // index → { id, name, argsBuf }
      let usage = { inputTokens: 0, outputTokens: 0 };

      const stream = await client.chat.completions.create({
        model: creds.model,
        messages: fullMessages,
        ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
        temperature,
        stream: true,
        stream_options: { include_usage: true },
        ...(extraBody ? { extra_body: extraBody } : {}),
      }, { signal });

      for await (const chunk of stream) {
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens || 0,
            outputTokens: chunk.usage.completion_tokens || 0,
          };
        }
        const delta = chunk.choices?.[0]?.delta || {};
        if (delta.content) {
          contentBuf += delta.content;
          onChunk?.(delta.content);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallBufs[idx]) toolCallBufs[idx] = { id: tc.id || "", name: tc.function?.name || "", argsBuf: "" };
            if (tc.id) toolCallBufs[idx].id = tc.id;
            if (tc.function?.name) toolCallBufs[idx].name = tc.function.name;
            if (tc.function?.arguments) toolCallBufs[idx].argsBuf += tc.function.arguments;
          }
        }
      }

      const toolCalls = Object.values(toolCallBufs).map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.argsBuf },
      }));

      return {
        message: { role: "assistant", content: contentBuf || null, tool_calls: toolCalls.length ? toolCalls : undefined },
        usage,
      };
    } catch (err) {
      // Don't fall back on a real abort, and only when we haven't streamed a
      // user-visible answer yet (a partial stream can't be cleanly retried).
      if (signal?.aborted) throw err;
      // A gateway we have not allow-listed still rejects the extension. Retry
      // once without it rather than losing the run to a request-shape quibble.
      if (rejectsExtraBody(err)) {
        console.warn(`[AgentChat] ${creds.model} rejected extra_body — retrying without it`);
        return nonStreamingCall(true);
      }
      if (!looksLikeBadStream(err)) throw err;
      console.warn("[AgentChat] streaming returned malformed data — retrying non-streaming:", String(err?.message || err).slice(0, 140));
      return nonStreamingCall();
    }
  }

  try {
    return await nonStreamingCall();
  } catch (err) {
    if (!signal?.aborted && rejectsExtraBody(err)) {
      console.warn(`[AgentChat] ${creds.model} rejected extra_body — retrying without it`);
      return nonStreamingCall(true);
    }
    throw err;
  }
}

// ── Transport-error classification ────────────────────────────────────────────

/**
 * Transport failures worth retrying. Deliberately narrow: these are all
 * "the pipe broke", never "the server rejected this request".
 */
const TRANSIENT_TRANSPORT_RE =
  /\bAPIConnectionError\b|\bconnection error\b|\bUND_ERR_SOCKET\b|\bUND_ERR_CONNECT_TIMEOUT\b|\bother side closed\b|\bECONNRESET\b|\bECONNABORTED\b|\bECONNREFUSED\b|\bEPIPE\b|\bETIMEDOUT\b|\bEAI_AGAIN\b|\bsocket hang ?up\b|\bfetch failed\b|\bpremature close\b|\bnetwork ?error\b|\bterminated\b/i;

/**
 * HTTP statuses that mean "retry later" rather than "you asked wrong".
 * 408 request timeout, 425 too early, 429 rate limit, 5xx server-side.
 */
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

/**
 * Statuses that are NEVER transient, whatever the message happens to contain.
 * Checked FIRST and unconditionally: a 403 quota error whose body mentions
 * "connection" must not be retried into the ground, and retrying a 401 is just
 * a slower way to fail.
 */
const PERMANENT_STATUSES = new Set([400, 401, 402, 403, 404, 405, 409, 413, 422]);

/** Wording that marks a refusal even when no status is exposed. */
const PERMANENT_MESSAGE_RE =
  /\binsufficient[_ ]?(?:user[_ ]?)?quota\b|\bquota\b|\bbilling\b|\bcredit balance\b|\binvalid[_ ]api[_ ]key\b|\bincorrect api key\b|\bunauthorized\b|\bauthentication\b|\bpermission denied\b|\binvalid[_ ]request[_ ]error\b|\bmodel_not_found\b|\bdoes not exist\b/i;

/**
 * Walk an error's `cause` chain, bounded, collecting the text that identifies
 * it. The OpenAI SDK reports every transport failure as the single string
 * "Connection error." and hides the real reason (UND_ERR_SOCKET, "other side
 * closed") in `err.cause` — so a classifier that reads only `err.message`
 * cannot tell a dropped socket from anything else, and the agent loop's
 * retry-with-backoff never engages. Bounded depth because a cause chain can be
 * cyclic.
 */
export function describeErrorChain(err, maxDepth = 5) {
  const parts = [];
  let status;
  let node = err;
  const seen = new Set();

  for (let depth = 0; depth < maxDepth && node && typeof node === "object"; depth++) {
    if (seen.has(node)) break;
    seen.add(node);
    for (const key of ["name", "message", "code", "type", "errno", "syscall"]) {
      const v = node[key];
      if (v !== undefined && v !== null && v !== "") parts.push(String(v));
    }
    const s = node.status ?? node.statusCode ?? node.response?.status;
    if (status === undefined && typeof s === "number") status = s;
    node = node.cause;
  }
  if (!parts.length && err !== undefined) parts.push(String(err));
  return { text: parts.join(" | "), status };
}

/**
 * Should the agent loop retry this failure?
 *
 * Order matters: a permanent status or a refusal phrase wins outright, so that
 * broadening transport matching can never accidentally start retrying auth or
 * quota errors.
 */
export function isTransientTransportError(err) {
  const { text, status } = describeErrorChain(err);
  if (status !== undefined && PERMANENT_STATUSES.has(status)) return false;
  if (PERMANENT_MESSAGE_RE.test(text)) return false;
  if (status !== undefined && TRANSIENT_STATUSES.has(status)) return true;
  return TRANSIENT_TRANSPORT_RE.test(text);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * chatWithTools — one turn of a tool-calling conversation.
 * creds: { apiKey, baseURL, model }
 * messages: OpenAI-format conversation (WITHOUT the system message)
 */
export async function chatWithTools({ creds, system, messages, tools = [], maxTokens = 4000, temperature = 0, signal, onChunk, thinking }) {
  if (isAnthropicRoute(creds)) {
    // Anthropic has no enable_thinking request param in this code path (that
    // would be a separate `thinking: {type:"enabled", budget_tokens}` request
    // field, not implemented here) — `thinking` is simply unused for this route.
    return anthropicChat({ creds, system, messages, tools, maxTokens, temperature, signal, onChunk });
  }
  return openaiChat({ creds, system, messages, tools, maxTokens, temperature, signal, onChunk, thinking });
}
