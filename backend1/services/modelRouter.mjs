// services/modelRouter.mjs
// Smart model router for Kodo Agent.
// Switches to a vision-capable model only when an IMAGE is attached — text and
// PDF attachments are extracted to text server-side, so they work with any model.

import { getModel, hasVision } from "../config/models.mjs";

// Back-compat: the second arg used to be a boolean `hasAttachments`. It now
// accepts either that (treated as "images may be present" for old callers) or
// an options object { hasImageAttachments }. Only images require vision.
export function routeModel(userSettings, attachmentsOrOpts = false) {
  const hasImageAttachments =
    typeof attachmentsOrOpts === "object" && attachmentsOrOpts !== null
      ? !!attachmentsOrOpts.hasImageAttachments
      : !!attachmentsOrOpts;

  // If no settings configured, return error state
  if (!userSettings || !userSettings.textProvider || !userSettings.textApiKey) {
    return {
      ok: false,
      error: "no_config",
      message: "Please configure your API key and model in settings.",
      uploadEnabled: false,
    };
  }

  // Check if user has vision model configured
  const visionConfigured =
    userSettings.visionProvider &&
    userSettings.visionModel &&
    userSettings.visionApiKey;

  // No IMAGE attached → the text model handles it (text/PDF are extracted to
  // text, so no vision model is needed).
  if (!hasImageAttachments) {
    const model = getModel(userSettings.textProvider, userSettings.textModel);
    return {
      ok: true,
      provider: userSettings.textProvider,
      model: userSettings.textModel,
      apiKey: userSettings.textApiKey,
      baseUrl: userSettings.textBaseUrl || model?.baseUrl,
      switchedModel: false,
      uploadEnabled: !!visionConfigured,
    };
  }

  // An image is attached → need a vision model
  if (!visionConfigured) {
    return {
      ok: false,
      error: "no_vision",
      message:
        "To attach images, add a vision-capable model in settings. (Text and PDF files work with your current model — no vision needed.)",
      uploadEnabled: false,
    };
  }

  // Check if selected vision model actually supports vision
  if (!hasVision(userSettings.visionProvider, userSettings.visionModel)) {
    return {
      ok: false,
      error: "model_no_vision",
      message: `${userSettings.visionModel} does not support file uploads. Please choose a vision-capable model.`,
      uploadEnabled: false,
    };
  }

  const model = getModel(userSettings.visionProvider, userSettings.visionModel);
  return {
    ok: true,
    provider: userSettings.visionProvider,
    model: userSettings.visionModel,
    apiKey: userSettings.visionApiKey,
    baseUrl: userSettings.textBaseUrl || model?.baseUrl,
    switchedModel: true,
    switchedFrom: userSettings.textModel,
    switchedTo: userSettings.visionModel,
    uploadEnabled: true,
  };
}

export function getCapabilities(userSettings) {
  const hasText =
    userSettings?.textProvider &&
    userSettings?.textModel &&
    userSettings?.textApiKey;

  const hasVisionConfig =
    userSettings?.visionProvider &&
    userSettings?.visionModel &&
    userSettings?.visionApiKey;

  const visionModelValid = hasVisionConfig
    ? hasVision(userSettings.visionProvider, userSettings.visionModel)
    : false;

  return {
    chatEnabled: !!hasText,
    uploadEnabled: !!hasVisionConfig && visionModelValid,
    textModel: hasText
      ? { provider: userSettings.textProvider, model: userSettings.textModel }
      : null,
    visionModel: visionModelValid
      ? {
          provider: userSettings.visionProvider,
          model: userSettings.visionModel,
        }
      : null,
  };
}
