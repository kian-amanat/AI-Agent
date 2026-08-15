/**
 * src/creds.mjs — turning resolved config into a modelRoute the agent accepts.
 *
 * The agent takes an explicit `modelRoute` ({ok, model, apiKey, baseUrl}). It
 * also has an internal fallback chain (resolveCreds in agent_loop.mjs) that
 * ends at backend1/data/settings.json — the WEB APP's saved settings, belonging
 * to whichever account last used the browser UI.
 *
 * The CLI always passes an explicit route and never lets that fallback fire.
 * A terminal user who has not configured Kodo must be told so, not quietly
 * credentialed with someone else's key and billed for it — the benchmark runner
 * refuses for the same reason (see bench/drivers.mjs).
 */

import { authError, configError } from "./exit.mjs";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * @param {object} config resolved by resolveConfig()
 * @returns {{ok: true, model, apiKey, baseUrl, provider}}
 */
export function buildModelRoute(config) {
  const apiKey  = config.apiKey || config.textApiKey || "";
  const model   = config.model  || config.textModel  || "";
  const baseUrl = config.baseUrl || config.textBaseUrl || DEFAULT_BASE_URL;

  if (!model) {
    throw configError(
      "No model is configured.",
      "Run `kodo config set model <model-name>`, or set DEFAULT_MODEL in the environment.",
    );
  }
  if (!apiKey) {
    throw authError(
      "No API key is configured.",
      "Run `kodo config set apiKey <key>`, or set OPENAI_API_KEY in the environment. " +
      "Kodo will not fall back to another account's saved key.",
    );
  }

  return {
    ok: true,
    model,
    apiKey,
    baseUrl,
    provider: config.provider || "",
  };
}

/** Non-throwing variant for `doctor` and `status`, which report rather than run. */
export function inspectModelRoute(config) {
  try {
    const route = buildModelRoute(config);
    return { ok: true, model: route.model, baseUrl: route.baseUrl, provider: route.provider };
  } catch (err) {
    return { ok: false, reason: err.message, hint: err.hint || "" };
  }
}
