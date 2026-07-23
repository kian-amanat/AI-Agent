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

const ANTHROPIC_VERSION = "2023-06-01";

export function isAnthropicRoute(creds) {
  return /anthropic\.com/i.test(String(creds?.baseURL || "")) ||
         /^claude-/i.test(String(creds?.model || ""));
}

// ── Anthropic conversion ──────────────────────────────────────────────────────

function toAnthropicTools(tools = []) {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description || "",
    input_schema: t.function.parameters || { type: "object", properties: {} },
  }));
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
    headers: {
      "content-type": "application/json",
      "x-api-key": creds.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: creds.model,
      max_tokens: maxTokens,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(system ? { system } : {}),
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
      ...(system ? { system } : {}),
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

async function openaiChat({ creds, system, messages, tools, maxTokens, temperature, signal, onChunk }) {
  const isThinkingModel = /thinking|r1\b|reasoner/i.test(creds.model);
  const client = new OpenAI({
    apiKey: creds.apiKey,
    baseURL: creds.baseURL,
    timeout: isThinkingModel ? 600_000 : 90_000,
    maxRetries: 0,
  });

  const fullMessages = [
    ...(system ? [{ role: "system", content: system }] : []),
    ...messages,
  ];

  // A plain (non-streamed) request. Also the fallback when streaming breaks:
  // some OpenAI-compatible providers return malformed SSE for tool-calling
  // turns, which the SDK surfaces as a JSON "Extra data" / SyntaxError. Rather
  // than fail the whole turn, we retry once without streaming.
  const nonStreamingCall = async () => {
    const response = await client.chat.completions.create({
      model: creds.model,
      messages: fullMessages,
      ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
      temperature,
      max_tokens: maxTokens,
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
  if (isThinkingModel || onChunk) {
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
        ...(isThinkingModel ? { extra_body: { enable_thinking: true } } : {}),
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
      if (signal?.aborted || !looksLikeBadStream(err)) throw err;
      console.warn("[AgentChat] streaming returned malformed data — retrying non-streaming:", String(err?.message || err).slice(0, 140));
      return nonStreamingCall();
    }
  }

  return nonStreamingCall();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * chatWithTools — one turn of a tool-calling conversation.
 * creds: { apiKey, baseURL, model }
 * messages: OpenAI-format conversation (WITHOUT the system message)
 */
export async function chatWithTools({ creds, system, messages, tools = [], maxTokens = 4000, temperature = 0, signal, onChunk }) {
  if (isAnthropicRoute(creds)) {
    return anthropicChat({ creds, system, messages, tools, maxTokens, temperature, signal, onChunk });
  }
  return openaiChat({ creds, system, messages, tools, maxTokens, temperature, signal, onChunk });
}
