import fs from "fs/promises";
import path from "path";
import { listProviders, getModel } from "../config/models.mjs";
import { getCapabilities } from "../services/modelRouter.mjs";
import { chatWithTools } from "../services/agentChat.mjs";
import db, { getUserSettings, saveUserSettings, userHasSettings } from "../db.mjs";

// Legacy single-file store. Still read ONCE per user to seed their per-user
// row (so existing installs don't lose their config on upgrade), never written.
const SETTINGS_PATH = path.join(process.cwd(), "data", "settings.json");

// Resolve the authenticated user from the Bearer token (same scheme the agent
// route uses). Settings are now per-user, so every settings request needs one.
function getUserIdFromRequest(request) {
  try {
    const auth = request.headers["authorization"];
    if (!auth?.startsWith("Bearer ")) return null;
    const token = auth.slice(7).trim();
    const row = db.prepare("SELECT user_id FROM auth_sessions WHERE token = ?").get(token);
    return row?.user_id ?? null;
  } catch {
    return null;
  }
}

// ── GapGPT dynamic models cache ──────────────────────────────────────────────
let gapgptModelsCache = null;
let gapgptCacheTime = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// ── Settings helpers ────────────────────────────────────────────────────────
// Read the legacy global file (used only to seed a user's first per-user row).
async function loadGlobalSettingsFile() {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Per-user settings load. On a user's very first read, if they have no row yet
// but the legacy global file exists, migrate it into their row once so existing
// single-user installs keep working after the multi-user upgrade.
async function loadSettings(userId) {
  if (!userId) return null;
  const existing = getUserSettings(userId);
  if (existing) return existing;

  if (!userHasSettings(userId)) {
    const legacy = await loadGlobalSettingsFile();
    if (legacy) {
      saveUserSettings(userId, legacy);
      return legacy;
    }
  }
  return null;
}

async function saveSettingsFile(userId, settings) {
  saveUserSettings(userId, settings);
}

// ── GapGPT API key ──────────────────────────────────────────────────────────
function getGapGPTKey() {
  return process.env.OPENAI_API_KEY || "";
}

function prettifyModelName(modelId) {
  return String(modelId || "")
    .replace(/^gapgpt-/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function inferVisionFromId(modelId) {
  return /(\bvision\b|\bvl\b|multimodal|image)/i.test(String(modelId || ""));
}

// Providers not in this fixed registry (config/models.mjs) still work — any
// base URL that doesn't match a known provider falls back to "custom", a
// generic OpenAI-compatible passthrough (see CUSTOM_PROVIDER_IDS below).
function inferProviderFromBaseUrl(baseUrl = "") {
  const url = String(baseUrl || "").toLowerCase();
  if (!url) return "";

  if (url.includes("gapgpt.app")) return "gapgpt";
  if (url.includes("api.openai.com")) return "openai";
  if (url.includes("anthropic")) return "anthropic";
  if (url.includes("dashscope") || url.includes("qwen")) return "qwen";
  if (url.includes("deepseek")) return "deepseek";
  if (url.includes("ollama") || url.includes("localhost") || url.includes("127.0.0.1")) {
    return "local";
  }

  return "custom";
}

// Providers whose models aren't (and can't be) enumerated in config/models.mjs:
// GapGPT is fetched dynamically from its /v1/models endpoint, "custom" is any
// other OpenAI-compatible endpoint the user points at (self-hosted gateways,
// third-party resellers, etc). Both skip the fixed-registry model lookup and
// are used exactly as typed — provider, model id, baseUrl, apiKey.
const OPEN_MODEL_PROVIDERS = new Set(["gapgpt", "custom", "local"]);

function normalizeGapGPTModel(raw) {
  const id = String(raw?.id || "").trim();
  if (!id) return null;

  const name =
    typeof raw?.name === "string" && raw.name.trim()
      ? raw.name.trim()
      : prettifyModelName(id);

  const vision =
    typeof raw?.vision === "boolean"
      ? raw.vision
      : inferVisionFromId(id) || inferVisionFromId(name);

  const thinking =
    typeof raw?.thinking === "boolean"
      ? raw.thinking
      : /thinking|reason/i.test(id) || /thinking|reason/i.test(name);

  return {
    id,
    name,
    vision,
    thinking,
  };
}

async function fetchGapGPTModels() {
  if (gapgptModelsCache && Date.now() - gapgptCacheTime < CACHE_TTL) {
    return gapgptModelsCache;
  }

  const apiKey = getGapGPTKey();

  if (!apiKey) {
    gapgptModelsCache = [];
    gapgptCacheTime = Date.now();
    return [];
  }

  try {
    const res = await fetch("https://api.gapgpt.app/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      throw new Error(`GapGPT API returned ${res.status}`);
    }

    const data = await res.json();
    const rawModels = Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.models)
        ? data.models
        : Array.isArray(data)
          ? data
          : [];

    const models = rawModels
      .map((m) => normalizeGapGPTModel(m))
      .filter(Boolean);

    gapgptModelsCache = models;
    gapgptCacheTime = Date.now();

    return models;
  } catch (err) {
    console.warn("[settings] GapGPT /v1/models fetch failed:", err.message);
    gapgptModelsCache = [];
    gapgptCacheTime = Date.now();
    return [];
  }
}

async function getGapGPTModelById(modelId) {
  const models = await fetchGapGPTModels();
  return models.find((m) => m.id === modelId) || null;
}

async function buildProvidersWithGapGPT() {
  const providers = listProviders();
  const gapgptModels = await fetchGapGPTModels();

  const next = providers.map((provider) => {
    if (provider.id !== "gapgpt") return provider;

    return {
      ...provider,
      models: gapgptModels,
    };
  });

  if (!next.some((provider) => provider.id === "gapgpt")) {
    next.unshift({
      id: "gapgpt",
      name: "GapGPT",
      models: gapgptModels,
    });
  }

  return next;
}

// Users sometimes paste the full endpoint URL (as shown in a provider's docs/
// curl example) instead of just the API root — e.g. ".../v1/chat/completions"
// instead of ".../v1". The OpenAI SDK appends "/chat/completions" itself, so
// leaving the suffix in place doubles it up and 404s. Strip it back to the root.
function stripEndpointSuffix(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(chat\/completions|completions|messages)$/i, "");
}

function normalizeSettingsBody(body = {}) {
  const baseUrl = stripEndpointSuffix(body.baseUrl || body.textBaseUrl || "");
  const visionBaseUrl = stripEndpointSuffix(body.visionBaseUrl || "");
  const inferredProvider = inferProviderFromBaseUrl(baseUrl || body.visionBaseUrl || "");
  const inferredVisionProvider = inferProviderFromBaseUrl(visionBaseUrl || baseUrl);

  return {
    provider: String(body.provider || body.textProvider || inferredProvider || "").trim(),
    model: String(body.model || body.textModel || "").trim(),
    apiKey: String(body.apiKey || body.textApiKey || "").trim(),
    baseUrl: baseUrl || visionBaseUrl,
    visionProvider: String(body.visionProvider || (visionBaseUrl ? inferredVisionProvider : "")).trim(),
    visionModel: String(body.visionModel || "").trim(),
    visionApiKey: String(body.visionApiKey || "").trim(),
    visionBaseUrl,
    useVisionSameKey: Boolean(body.useVisionSameKey),
  };
}

function maskKey(value) {
  if (!value || typeof value !== "string") return value;
  if (value.length <= 4) return "***";
  return "***" + value.slice(-4);
}

export default async function settingsRoutes(fastify) {
  // ── GET /providers ────────────────────────────────────────────────────────
  fastify.get("/providers", async () => {
    const providers = await buildProvidersWithGapGPT();
    return { ok: true, providers };
  });

  // ── GET /gapgpt-models ────────────────────────────────────────────────────
  fastify.get("/gapgpt-models", async () => {
    const models = await fetchGapGPTModels();

    return {
      ok: true,
      models,
      cached: Boolean(gapgptModelsCache?.length),
    };
  });

  // ── GET / ─────────────────────────────────────────────────────────────────
  fastify.get("/", async (request, reply) => {
    const userId = getUserIdFromRequest(request);
    if (!userId) return reply.code(401).send({ ok: false, error: "Unauthorized" });
    const settings = await loadSettings(userId);

    if (!settings) {
      return {
        ok: true,
        configured: false,
        settings: null,
        capabilities: {
          chatEnabled: false,
          uploadEnabled: false,
          textModel: null,
          visionModel: null,
        },
      };
    }

    const masked = { ...settings };

    if (masked.apiKey) masked.apiKey = maskKey(masked.apiKey);
    if (masked.textApiKey) masked.textApiKey = maskKey(masked.textApiKey);
    if (masked.visionApiKey) masked.visionApiKey = maskKey(masked.visionApiKey);

    return {
      ok: true,
      configured: true,
      settings: masked,
      capabilities: getCapabilities(settings),
    };
  });

  // ── POST / (save settings) ─────────────────────────────────────────────────
  fastify.post("/", async (request, reply) => {
    const userId = getUserIdFromRequest(request);
    if (!userId) return reply.code(401).send({ ok: false, error: "Unauthorized" });
    const body = normalizeSettingsBody(request.body || {});

    console.log("[SETTINGS SAVE] user =>", userId, "normalized =>", { ...body, apiKey: body.apiKey ? "***" : "" });

    if (!body.provider || !body.model || !body.apiKey) {
      return reply.code(400).send({
        ok: false,
        error: "provider, model, and apiKey are required.",
      });
    }

    // "custom" providers have no fixed base URL — the user must supply one.
    if (body.provider === "custom" && !body.baseUrl) {
      return reply.code(400).send({
        ok: false,
        error: "baseUrl is required for a custom provider.",
      });
    }

    // Validate against the fixed model registry only for providers that have
    // one; GapGPT and custom endpoints use whatever model id was typed.
    if (!OPEN_MODEL_PROVIDERS.has(body.provider)) {
      const textModel = getModel(body.provider, body.model);
      if (!textModel) {
        return reply.code(400).send({
          ok: false,
          error: `Unknown model: ${body.provider}/${body.model}`,
        });
      }
    }

    const resolvedBaseUrl =
      body.baseUrl ||
      (body.provider === "gapgpt" ? "https://api.gapgpt.app/v1" : null) ||
      (body.provider === "local" ? "http://localhost:11434/v1" : null);

    const settings = {
      // canonical shape
      provider: body.provider,
      model: body.model,
      apiKey: body.apiKey,
      baseUrl: resolvedBaseUrl,

      // legacy shape kept for compatibility
      textProvider: body.provider,
      textModel: body.model,
      textApiKey: body.apiKey,
      textBaseUrl: resolvedBaseUrl,

      visionProvider: body.visionProvider || null,
      visionModel: body.visionModel || null,
      visionApiKey: body.visionApiKey || null,
      visionBaseUrl: body.visionBaseUrl || null,
      useVisionSameKey: body.useVisionSameKey,
    };

    if (settings.useVisionSameKey && settings.visionProvider && settings.visionModel) {
      settings.visionApiKey = settings.apiKey;
      settings.visionBaseUrl = settings.baseUrl;
    }

    // Vision validation
    if (settings.visionProvider && settings.visionModel) {
      if (settings.visionProvider === "gapgpt") {
        const gapgptModel = await getGapGPTModelById(settings.visionModel);

        if (gapgptModel && gapgptModel.vision === false) {
          return reply.code(400).send({
            ok: false,
            error: `${gapgptModel.name} does not support vision/file uploads.`,
          });
        }
      } else if (settings.visionProvider === "custom") {
        // Can't verify vision support for an arbitrary endpoint — trust the user.
      } else {
        const vm = getModel(settings.visionProvider, settings.visionModel);
        if (!vm) {
          return reply.code(400).send({
            ok: false,
            error: `Unknown vision model: ${settings.visionProvider}/${settings.visionModel}`,
          });
        }
        if (!vm.vision) {
          return reply.code(400).send({
            ok: false,
            error: `${vm.name} does not support vision/file uploads.`,
          });
        }
      }
    }

    await saveSettingsFile(userId, settings);

    return {
      ok: true,
      message: "Settings saved successfully.",
      capabilities: getCapabilities(settings),
    };
  });

  // ── POST /test ─────────────────────────────────────────────────────────────
  fastify.post("/test", async (request, reply) => {
    const body = normalizeSettingsBody(request.body || {});

    console.log("[SETTINGS TEST] raw body =>", request.body);
    console.log("[SETTINGS TEST] normalized =>", body);

    if (!body.model || !body.apiKey) {
      return reply.code(400).send({
        ok: false,
        error: "model and apiKey are required.",
      });
    }

    const provider = body.provider || inferProviderFromBaseUrl(body.baseUrl);
    if (!provider) {
      return reply.code(400).send({
        ok: false,
        error: "provider is required.",
      });
    }

    if (provider === "custom" && !body.baseUrl) {
      return reply.code(400).send({
        ok: false,
        error: "baseUrl is required for a custom provider.",
      });
    }

    let baseUrl = body.baseUrl || "";
    let modelName = body.model;

    if (provider === "gapgpt") {
      baseUrl = baseUrl || "https://api.gapgpt.app/v1";

      const gapgptModel = await getGapGPTModelById(body.model);
      modelName = gapgptModel?.name || prettifyModelName(body.model);
    } else if (provider === "custom" || provider === "local") {
      modelName = prettifyModelName(body.model);
    } else {
      const modelInfo = getModel(provider, body.model);
      if (!modelInfo) {
        return reply.code(400).send({
          ok: false,
          error: `Unknown model: ${provider}/${body.model}`,
        });
      }

      baseUrl = baseUrl || modelInfo.baseUrl;
      modelName = modelInfo.name;
    }

    // Route through the same protocol adapter real chat requests use — this
    // is what makes the test correct for Anthropic (native Messages API,
    // x-api-key header) instead of assuming every provider speaks the OpenAI
    // /chat/completions shape.
    try {
      await chatWithTools({
        creds: { apiKey: body.apiKey, baseURL: baseUrl, model: body.model },
        messages: [{ role: "user", content: "Hi" }],
        maxTokens: 5,
        temperature: 0,
        signal: AbortSignal.timeout(10000),
      });

      return {
        ok: true,
        message: `Connected to ${modelName} successfully.`,
      };
    } catch (err) {
      return {
        ok: false,
        error: `Connection failed: ${err.message}`,
      };
    }
  });

  // ── GET /capabilities ──────────────────────────────────────────────────────
  fastify.get("/capabilities", async (request, reply) => {
    const userId = getUserIdFromRequest(request);
    if (!userId) return reply.code(401).send({ ok: false, error: "Unauthorized" });
    const settings = await loadSettings(userId);
    return { ok: true, ...getCapabilities(settings) };
  });
}