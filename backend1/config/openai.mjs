import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The repo root — NOT process.cwd(). The backend is normally launched via
// `npm --prefix backend1 run dev`, which sets cwd to backend1/ itself; falling
// back to cwd() silently scoped every path-confined tool (file reads, attachment
// resolution, the workspace file tree/root-picker) to backend1/ only, hiding
// chatbot/my-chatbot-ui/ from the agent entirely. Compute the real root the same
// way agent_loop.mjs and undo.service.mjs already do (2 levels up from
// backend1/config), and only let WORKSPACE_PATH override it explicitly.
export const PROJECT_ROOT = process.env.WORKSPACE_PATH || path.resolve(__dirname, "..", "..");
export const BACKEND_ROOT = path.join(PROJECT_ROOT, "backend");
export const FRONTEND_ROOT = path.join(PROJECT_ROOT, "frontend");
export const PLANS_DIR = PROJECT_ROOT;

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

// NEVER hardcode keys here — a real key was once committed in this file.
// Configure via the .env file (OPENAI_API_KEY) or the in-app Settings page.
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// Default client — GapGPT (used when no user settings configured).
//
// Constructed LAZILY. The OpenAI SDK throws from its constructor when no key is
// present, and this module is reached transitively from utils/path.util.mjs →
// agent_loop.mjs → basically the whole agent. Building the client eagerly meant
// that merely IMPORTING the agent required credentials: `kodo --version`,
// `kodo doctor` and the offline test suite all died at module load on a machine
// that had simply not configured a key yet — which is exactly the machine those
// commands exist to help. Deferring construction to first real use keeps the
// failure where it belongs: at the call that actually needs the credential.
let _defaultClient = null;
function defaultClient() {
  if (!_defaultClient) {
    _defaultClient = new OpenAI({
      apiKey: OPENAI_API_KEY,
      baseURL: OPENAI_BASE_URL,
      timeout: 30000,
      maxRetries: 2,
    });
  }
  return _defaultClient;
}

export const openai = new Proxy(Object.create(null), {
  get(_target, prop) {
    const client = defaultClient();
    const value = client[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
  has(_target, prop) {
    return prop in defaultClient();
  },
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