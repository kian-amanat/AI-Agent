/**
 * services/llm.mjs
 * Reads credentials from modelRoute OR data/settings.json directly.
 * Settings field names: textApiKey, textBaseUrl, textModel
 * modelRoute field names: apiKey, baseUrl, model  (from modelRouter.mjs)
 */

import OpenAI from "openai";
import { readFile } from "fs/promises";
import path from "path";

const SETTINGS_PATH = path.join(process.cwd(), "data", "settings.json");

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
      apiKey:  modelRoute.apiKey,
      baseURL: modelRoute.baseUrl || "https://api.openai.com/v1",
      model:   modelRoute.model,
    };
  }

  // 2. Read settings.json directly — field names: textApiKey, textBaseUrl, textModel
  const s = await loadSettings();
  if (s?.textApiKey && s?.textModel) {
    console.log(`[LLM] using settings.json: ${s.textProvider || ""}/${s.textModel}`);
    return {
      apiKey:  s.textApiKey,
      baseURL: s.textBaseUrl || "https://api.openai.com/v1",
      model:   s.textModel,
    };
  }

  // 3. Also try top-level keys (apiKey / model / baseUrl)
  if (s?.apiKey && s?.model) {
    console.log(`[LLM] using settings.json top-level: ${s.model}`);
    return {
      apiKey:  s.apiKey,
      baseURL: s.baseUrl || "https://api.openai.com/v1",
      model:   s.model,
    };
  }

  // 4. env vars last resort
  const apiKey = process.env.OPENAI_API_KEY || process.env.USER_API_KEY || "";
  const baseURL = process.env.OPENAI_BASE_URL || process.env.USER_BASE_URL || "https://api.openai.com/v1";
  const model   = process.env.DEFAULT_MODEL || process.env.USER_MODEL || "gpt-4o-mini";

  if (!apiKey) {
    throw new Error("No API key found. Configure it in Kodo settings.");
  }

  console.log(`[LLM] using env vars: ${model}`);
  return { apiKey, baseURL, model };
}

function makeClient({ apiKey, baseURL }) {
  return new OpenAI({
    apiKey,
    baseURL,
    defaultHeaders: { "Authorization": `Bearer ${apiKey}`, "X-API-Key": apiKey },
    timeout: 150_000,
    maxRetries: 0,  // don't retry — let the graph handle errors
  });
}

// ── callLLM ───────────────────────────────────────────────────
export async function callLLM({
  system,
  messages = [],
  modelRoute,
  maxTokens   = 4000,
  temperature = 0.3,
}) {
  const creds  = await resolveCredentials(modelRoute);
  const client = makeClient(creds);

  console.log(`[LLM] callLLM → model=${creds.model} baseURL=${creds.baseURL}`);

  const fullMessages = [
    ...(system ? [{ role: "system", content: system }] : []),
    ...messages,
  ];

  const response = await client.chat.completions.create({
    model:       creds.model,
    messages:    fullMessages,
    max_tokens:  maxTokens,
    temperature,
  });

  const content = response.choices?.[0]?.message?.content || "";
  return { content };
}

// ── streamLLM ─────────────────────────────────────────────────
export async function streamLLM({
  system,
  messages = [],
  modelRoute,
  maxTokens   = 4000,
  temperature = 0.3,
  onChunk,
}) {
  const creds  = await resolveCredentials(modelRoute);
  const client = makeClient(creds);

  console.log(`[LLM] streamLLM → model=${creds.model} baseURL=${creds.baseURL}`);

  const fullMessages = [
    ...(system ? [{ role: "system", content: system }] : []),
    ...messages,
  ];

  const stream = await client.chat.completions.create({
    model:       creds.model,
    messages:    fullMessages,
    max_tokens:  maxTokens,
    temperature,
    stream:      true,
  });

  for await (const chunk of stream) {
    const token = chunk.choices?.[0]?.delta?.content;
    if (token) onChunk?.(token);
  }
}
