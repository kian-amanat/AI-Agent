// config/models.mjs
// Registry of supported AI providers and models with their capabilities.
// Add new models here — the router and settings UI read from this file.

export const PROVIDERS = {
  openai: {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: {
      "gpt-4o": { name: "GPT-4o", vision: true, maxTokens: 128000 },
      "gpt-4o-mini": { name: "GPT-4o Mini", vision: true, maxTokens: 128000 },
      "gpt-4.1": { name: "GPT-4.1", vision: true, maxTokens: 128000 },
      "gpt-4.1-mini": { name: "GPT-4.1 Mini", vision: true, maxTokens: 128000 },
      "o3-mini": { name: "o3 Mini", vision: false, maxTokens: 128000 },
    },
  },
  anthropic: {
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    models: {
      "claude-sonnet-5":            { name: "Claude Sonnet 5",   vision: true, maxTokens: 200000 },
      "claude-opus-4-8":            { name: "Claude Opus 4.8",   vision: true, maxTokens: 200000 },
      "claude-haiku-4-5-20251001":  { name: "Claude Haiku 4.5",  vision: true, maxTokens: 200000 },
    },
  },
  qwen: {
    name: "Qwen (Dashscope)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: {
      "qwen-plus": { name: "Qwen Plus", vision: false, maxTokens: 32000 },
      "qwen-turbo": { name: "Qwen Turbo", vision: false, maxTokens: 8000 },
      "qwen-max": { name: "Qwen Max", vision: false, maxTokens: 32000 },
      "qwen-vl-max": { name: "Qwen VL Max", vision: true, maxTokens: 32000 },
    },
  },
  deepseek: {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    models: {
      "deepseek-chat": { name: "DeepSeek Chat", vision: false, maxTokens: 64000 },
      "deepseek-coder": { name: "DeepSeek Coder", vision: false, maxTokens: 64000 },
    },
  },
  local: {
    name: "Local (Ollama)",
    baseUrl: "http://localhost:11434/v1",
    models: {
      "llama3": { name: "Llama 3", vision: false, maxTokens: 8000 },
      "codellama": { name: "Code Llama", vision: false, maxTokens: 16000 },
      "llava": { name: "LLaVA", vision: true, maxTokens: 4000 },
    },
  },
  gapgpt: {
  name: "GapGPT",
  baseUrl: "https://api.gapgpt.app/v1",
  models: {
    "gapgpt-qwen-3.6": { name: "GapGPT Qwen 3.6", vision: false, maxTokens: 32000 },
    "gapgpt/whisper-1": { name: "GapGPT Whisper", vision: false, maxTokens: 0 },
  },
},
};

export function getModel(provider, modelId) {
  const p = PROVIDERS[provider];
  if (!p) return null;
  const m = p.models[modelId];
  if (!m) return null;
  return { ...m, id: modelId, provider, baseUrl: p.baseUrl };
}

export function hasVision(provider, modelId) {
  const m = getModel(provider, modelId);
  return m ? m.vision : false;
}

export function listProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    name: p.name,
    models: Object.entries(p.models).map(([mid, m]) => ({
      id: mid,
      name: m.name,
      vision: m.vision,
    })),
  }));
}
