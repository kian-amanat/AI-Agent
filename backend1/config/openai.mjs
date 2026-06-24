import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROJECT_ROOT = process.env.WORKSPACE_PATH || process.cwd();
export const BACKEND_ROOT = path.join(PROJECT_ROOT, "backend");
export const FRONTEND_ROOT = path.join(PROJECT_ROOT, "frontend");
export const PLANS_DIR = PROJECT_ROOT;

export const PIPELINE_SCRIPT = path.resolve(
  __dirname,
  "../../pipeline_agent.mjs"
);

// =========================
// Default models (GapGPT fallback)
// =========================

export const CHAT_MODEL =
  process.env.CHAT_MODEL || "gapgpt-qwen-3.6";

export const CODEGEN_MODEL =
  process.env.CODEGEN_MODEL || "gapgpt-qwen-3.6";

export const PLANNING_MODEL =
  process.env.PLANNING_MODEL || "gapgpt-qwen-3.6";

export const SUMMARY_MODEL =
  process.env.SUMMARY_MODEL || "gapgpt-qwen-3.6";

export const WHISPER_MODEL =
  process.env.WHISPER_MODEL || "gapgpt/whisper-1";

export const VISION_MODEL =
  process.env.VISION_MODEL || "gpt-4o-mini";

// =========================
// GapGPT default client
// =========================

export const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL || "https://api.gapgpt.app/v1";

export const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY ||
  "sk-Sy5TxZ3dcQAfM00dTwH5p8HqQ8hCqh2sf9TzNOfIfTYUmMnD";

// Default client — GapGPT (used when no user settings configured)
export const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL,
  timeout: 30000,
  maxRetries: 2,
});

// =========================
// Provider base URLs
// =========================

const PROVIDER_BASE_URLS = {
  openai: "https://api.openai.com/v1",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  deepseek: "https://api.deepseek.com/v1",
  local: "http://localhost:11434/v1",
  anthropic: "https://api.anthropic.com/v1",
  gapgpt: "https://api.gapgpt.app/v1",
};

export function createClient(route) {
  if (!route || !route.apiKey || !route.provider) {
    return { client: openai, model: CHAT_MODEL };
  }

  const baseURL =
    route.baseUrl ||
    PROVIDER_BASE_URLS[route.provider] ||
    OPENAI_BASE_URL;

  const client = new OpenAI({
    apiKey: route.apiKey,
    baseURL,
    timeout: 30000,
    maxRetries: 2,
  });

  return { client, model: route.model };
}

export function resolveClient(modelRoute, fallbackModel = CHAT_MODEL) {
  if (modelRoute?.ok && modelRoute?.apiKey) {
    const client = new OpenAI({
      apiKey: modelRoute.apiKey,
      baseURL: modelRoute.baseUrl || OPENAI_BASE_URL,
      timeout: 30000,
      maxRetries: 2,
    });
    return { client, model: modelRoute.model };
  }
  return { client: openai, model: fallbackModel };
}