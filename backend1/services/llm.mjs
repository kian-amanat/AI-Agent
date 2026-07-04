/**
 * services/llm.mjs
 * Reads credentials from modelRoute OR data/settings.json directly.
 * Settings field names: textApiKey, textBaseUrl, textModel
 * modelRoute field names: apiKey, baseUrl, model  (from modelRouter.mjs)
 *
 * Added:
 * - Retry logic for transient provider failures (504/502/503/429/timeouts)
 * - Slightly longer default timeout
 * - Shared helper for chat completion calls
 */

import OpenAI from "openai";
import { readFile } from "fs/promises";
import path from "path";

const SETTINGS_PATH = path.join(process.cwd(), "data", "settings.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err) {
  const status = Number(err?.status || err?.statusCode || err?.response?.status || 0);
  const msg = String(err?.message || err || "");

  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  if (/rate limit|timeout|timed out|gateway timeout|network error|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(msg)) return true;
  return false;
}

async function loadSettings() {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function resolveCredentials(modelRoute) {
  // 1. modelRoute passed per-request from plannerAgent (most reliable)
  //    modelRouter.mjs returns: { ok, model, provider, apiKey, baseUrl }
  if (modelRoute?.ok && modelRoute?.apiKey && modelRoute?.model) {
    console.log(`[LLM] using modelRoute: ${modelRoute.provider}/${modelRoute.model}`);
    return {
      apiKey: modelRoute.apiKey,
      baseURL: modelRoute.baseUrl || "https://api.openai.com/v1",
      model: modelRoute.model,
    };
  }

  // 2. Read settings.json directly — field names: textApiKey, textBaseUrl, textModel
  const s = await loadSettings();
  if (s?.textApiKey && s?.textModel) {
    console.log(`[LLM] using settings.json: ${s.textProvider || ""}/${s.textModel}`);
    return {
      apiKey: s.textApiKey,
      baseURL: s.textBaseUrl || "https://api.openai.com/v1",
      model: s.textModel,
    };
  }

  // 3. Also try top-level keys (apiKey / model / baseUrl)
  if (s?.apiKey && s?.model) {
    console.log(`[LLM] using settings.json top-level: ${s.model}`);
    return {
      apiKey: s.apiKey,
      baseURL: s.baseUrl || "https://api.openai.com/v1",
      model: s.model,
    };
  }

  // 4. env vars last resort
  const apiKey = process.env.OPENAI_API_KEY || process.env.USER_API_KEY || "";
  const baseURL = process.env.OPENAI_BASE_URL || process.env.USER_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.DEFAULT_MODEL || process.env.USER_MODEL || "gpt-4o-mini";

  if (!apiKey) {
    throw new Error("No API key found. Configure it in Kodo settings.");
  }

  console.log(`[LLM] using env vars: ${model}`);
  return { apiKey, baseURL, model };
}

function makeClient({ apiKey, baseURL }, timeout = 180_000) {
  return new OpenAI({
    apiKey,
    baseURL,
    defaultHeaders: {
      Authorization: `Bearer ${apiKey}`,
      "X-API-Key": apiKey,
    },
    timeout,
    maxRetries: 0, // let the graph handle retries
  });
}

async function chatCompletionWithRetry(client, params, retries = 1) {
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await client.chat.completions.create(params);
    } catch (err) {
      lastErr = err;
      if (attempt < retries && isRetryableError(err)) {
        await sleep(700 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }

  throw lastErr;
}

// ── callLLM ───────────────────────────────────────────────────
export async function callLLM({
  system,
  messages = [],
  modelRoute,
  maxTokens = 4000,
  temperature = 0.3,
  retries = 1,
  stream: useStream = false,
}) {
  const creds = await resolveCredentials(modelRoute);

  // Thinking models (qwen-*-thinking, *-r1, deepseek-reasoner) can reason for
  // minutes. Non-streaming requests get killed by gateway timeouts (504) before
  // the model finishes. Streaming keeps the connection alive token-by-token so
  // the gateway never sees an idle connection, no matter how long reasoning takes.
  const isThinkingModel = /thinking|r1\b|reasoner/i.test(creds.model);

  // Give thinking models a longer socket timeout (10 min) so streaming doesn't drop.
  const client = makeClient(creds, isThinkingModel ? 600_000 : 180_000);

  console.log(`[LLM] callLLM → model=${creds.model} baseURL=${creds.baseURL}${isThinkingModel ? " [streaming + reasoning]" : ""}`);

  const fullMessages = [
    ...(system ? [{ role: "system", content: system }] : []),
    ...messages,
  ];

  // ── Thinking model path: stream to avoid gateway timeout ──────────────────
  if (isThinkingModel) {
    let contentBuf = "";
    let reasoningBuf = "";
    let lastErr = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        contentBuf = "";
        reasoningBuf = "";

        const stream = await client.chat.completions.create({
          model: creds.model,
          messages: fullMessages,
          max_tokens: maxTokens,
          temperature,
          stream: true,
          extra_body: { enable_thinking: true },
        });

        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta || {};
          if (delta.content) contentBuf += delta.content;
          if (delta.reasoning_content) reasoningBuf += delta.reasoning_content;
        }

        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < retries && isRetryableError(err)) {
          await sleep(700 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }

    if (lastErr) throw lastErr;

    const content = extractMessageContent({ content: contentBuf, reasoning_content: reasoningBuf });
    if (!content.trim()) {
      console.warn(`[LLM] Empty after streaming. content=${contentBuf.length}c reasoning=${reasoningBuf.length}c`);
    } else {
      console.log(`[LLM] Streamed ${contentBuf.length + reasoningBuf.length} chars (${reasoningBuf.length} reasoning + ${contentBuf.length} response)`);
    }
    return { content };
  }

  // ── Streaming accumulation path (avoids gateway timeouts on large prompts) ──
  if (useStream) {
    let contentBuf = "";
    let lastErr = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        contentBuf = "";
        const stream = await client.chat.completions.create({
          model: creds.model,
          messages: fullMessages,
          max_tokens: maxTokens,
          temperature,
          stream: true,
        });

        for await (const chunk of stream) {
          const token = chunk.choices?.[0]?.delta?.content;
          if (token) contentBuf += token;
        }

        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < retries && isRetryableError(err)) {
          await sleep(700 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }

    if (lastErr) throw lastErr;
    if (!contentBuf.trim()) console.warn("[LLM] Empty after streaming accumulation.");
    return { content: contentBuf };
  }

  // ── Normal model path: single request ─────────────────────────────────────
  const response = await chatCompletionWithRetry(
    client,
    { model: creds.model, messages: fullMessages, max_tokens: maxTokens, temperature },
    retries
  );

  const msg = response.choices?.[0]?.message || {};
  const content = extractMessageContent(msg);
  if (!content.trim()) {
    console.warn("[LLM] Empty content. Raw message keys:", Object.keys(msg).join(", "));
  }
  return { content };
}

function extractMessageContent(msg) {
  let text = String(msg?.content || "").trim();

  // Thinking models (Qwen-thinking, DeepSeek-R1) may use reasoning_content
  if (!text && msg?.reasoning_content) {
    text = String(msg.reasoning_content).trim();
    console.log("[LLM] content empty — using reasoning_content");
  }

  if (!text) return "";

  // If content is wrapped in <think>…</think>, prefer what follows it
  const thinkEnd = text.lastIndexOf("</think>");
  if (thinkEnd !== -1) {
    const afterThink = text.slice(thinkEnd + 8).trim();
    if (afterThink) return afterThink;
    // fallback: pass the whole thing (extractJSON will find the JSON block inside)
  }

  return text;
}

// ── streamLLM ─────────────────────────────────────────────────
export async function streamLLM({
  system,
  messages = [],
  modelRoute,
  maxTokens = 4000,
  temperature = 0.3,
  onChunk,
  retries = 1,
}) {
  const creds = await resolveCredentials(modelRoute);
  const client = makeClient(creds);

  console.log(`[LLM] streamLLM → model=${creds.model} baseURL=${creds.baseURL}`);

  const fullMessages = [
    ...(system ? [{ role: "system", content: system }] : []),
    ...messages,
  ];

  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const stream = await client.chat.completions.create({
        model: creds.model,
        messages: fullMessages,
        max_tokens: maxTokens,
        temperature,
        stream: true,
      });

      for await (const chunk of stream) {
        const token = chunk.choices?.[0]?.delta?.content;
        if (token) onChunk?.(token);
      }

      return;
    } catch (err) {
      lastErr = err;
      if (attempt < retries && isRetryableError(err)) {
        await sleep(700 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }

  throw lastErr;
}