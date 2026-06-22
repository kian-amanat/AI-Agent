import fs from "fs/promises";
import path from "path";
import { listProviders, getModel } from "../config/models.mjs";
import { getCapabilities } from "../services/modelRouter.mjs";

const SETTINGS_PATH = path.join(process.cwd(), "data", "settings.json");

// ── GapGPT dynamic models cache ──────────────────────────────────────────────
let gapgptModelsCache = null;
let gapgptCacheTime = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// ── Settings file helpers ───────────────────────────────────────────────────
async function ensureDataDir() {
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
}

async function loadSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveSettingsFile(settings) {
  await ensureDataDir();
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
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

function inferProviderFromBaseUrl(baseUrl = "") {
  const url = String(baseUrl || "").toLowerCase();

  if (url.includes("gapgpt.app")) return "gapgpt";
  if (url.includes("api.openai.com")) return "openai";
  if (url.includes("anthropic")) return "anthropic";
  if (url.includes("dashscope") || url.includes("qwen")) return "qwen";
  if (url.includes("deepseek")) return "deepseek";
  if (url.includes("ollama") || url.includes("localhost") || url.includes("127.0.0.1")) {
    return "";
  }

  return "";
}

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

function normalizeSettingsBody(body = {}) {
  const baseUrl = String(body.baseUrl || body.textBaseUrl || body.visionBaseUrl || "").trim();
  const inferredProvider = inferProviderFromBaseUrl(baseUrl);

  return {
    provider: String(body.provider || body.textProvider || inferredProvider || "").trim(),
    model: String(body.model || body.textModel || "").trim(),
    apiKey: String(body.apiKey || body.textApiKey || "").trim(),
    baseUrl,
    visionProvider: String(body.visionProvider || "").trim(),
    visionModel: String(body.visionModel || "").trim(),
    visionApiKey: String(body.visionApiKey || "").trim(),
    visionBaseUrl: String(body.visionBaseUrl || "").trim(),
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
  fastify.get("/", async () => {
    const settings = await loadSettings();

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
    const body = normalizeSettingsBody(request.body || {});

    console.log("[SETTINGS SAVE] raw body =>", request.body);
    console.log("[SETTINGS SAVE] normalized =>", body);

    if (!body.provider || !body.model || !body.apiKey) {
      return reply.code(400).send({
        ok: false,
        error: "provider, model, and apiKey are required.",
      });
    }

    // Validate non-GapGPT text model only
    if (body.provider !== "gapgpt") {
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
      (body.provider === "gapgpt" ? "https://api.gapgpt.app/v1" : null);

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

    await saveSettingsFile(settings);

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

    let baseUrl = body.baseUrl || "";
    let modelName = body.model;

    if (provider === "gapgpt") {
      baseUrl = baseUrl || "https://api.gapgpt.app/v1";

      const gapgptModel = await getGapGPTModelById(body.model);
      modelName = gapgptModel?.name || prettifyModelName(body.model);
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

    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${body.apiKey}`,
        },
        body: JSON.stringify({
          model: body.model,
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 5,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return {
          ok: false,
          error: err.error?.message || `API returned ${res.status}`,
        };
      }

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
  fastify.get("/capabilities", async () => {
    const settings = await loadSettings();
    return { ok: true, ...getCapabilities(settings) };
  });
}