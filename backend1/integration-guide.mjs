// ============================================================
// 1) ADD THIS TO server.js (after your other route registrations)
// ============================================================

import settingsRoute from "./routes/settings.mjs";

// Register settings routes
await fastify.register(settingsRoute, {
  prefix: "/api/settings",
});


// ============================================================
// 2) HOW TO USE THE MODEL ROUTER IN YOUR PLANNER AGENT
//    (add this to your routes/plannerAgent.mjs or wherever
//     you call the AI model)
// ============================================================

import { routeModel } from "../services/modelRouter.mjs";
import fs from "fs/promises";
import path from "path";

const SETTINGS_PATH = path.join(process.cwd(), "data", "settings.json");

async function loadSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Example: inside your chat/planner endpoint
async function handleChatMessage(message, attachments = []) {
  const settings = await loadSettings();
  const hasAttachments = attachments.length > 0;

  // Smart routing: picks text model or vision model automatically
  const route = routeModel(settings, hasAttachments);

  if (!route.ok) {
    // Tell the user what's wrong
    return { ok: false, error: route.error, message: route.message };
  }

  // Log which model is being used
  if (route.switchedModel) {
    console.log(`[Kodo] Auto-switched from ${route.switchedFrom} to ${route.switchedTo} (file detected)`);
  }

  // Build the API request
  const messages = buildMessages(message, attachments, route);

  const response = await fetch(`${route.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${route.apiKey}`,
    },
    body: JSON.stringify({
      model: route.model,
      messages,
      max_tokens: 4096,
    }),
  });

  const data = await response.json();

  return {
    ok: true,
    response: data.choices?.[0]?.message?.content,
    model: route.model,
    switchedModel: route.switchedModel,
    // Show user which model answered (transparency)
    modelInfo: route.switchedModel
      ? `Switched to ${route.switchedTo} for file analysis`
      : `Using ${route.model}`,
  };
}

function buildMessages(message, attachments, route) {
  // No attachments: simple text message
  if (!attachments.length) {
    return [{ role: "user", content: message }];
  }

  // With attachments: build multimodal content array
  const content = [{ type: "text", text: message }];

  for (const file of attachments) {
    if (file.mimetype?.startsWith("image/")) {
      // Image: send as base64 or URL (OpenAI format)
      content.push({
        type: "image_url",
        image_url: {
          url: file.base64
            ? `data:${file.mimetype};base64,${file.base64}`
            : file.url,
        },
      });
    } else {
      // Other files: append content as text
      content.push({
        type: "text",
        text: `[File: ${file.originalName}]\n${file.textContent || "(binary file attached)"}`,
      });
    }
  }

  return [{ role: "user", content }];
}


// ============================================================
// 3) API FLOW SUMMARY
// ============================================================
//
// Frontend (Chat UI) calls these endpoints:
//
// On page load:
//   GET /api/settings              → check if configured
//   GET /api/settings/capabilities → enable/disable upload button
//   GET /api/settings/providers    → populate model dropdowns
//
// Settings page:
//   POST /api/settings             → save API keys & models
//   POST /api/settings/test        → test API key works
//
// Chat:
//   POST /api/agent/chat           → send message (your planner)
//     → modelRouter picks the right model automatically
//     → if file attached + no vision model → returns error with helpful message
//     → if file attached + vision model → auto-switches and processes
//
// File structure:
//   project/
//   ├── server.js
//   ├── config/
//   │   └── models.mjs          ← model registry
//   ├── services/
//   │   └── modelRouter.mjs     ← smart routing logic
//   ├── routes/
//   │   ├── plannerAgent.mjs    ← your existing agent routes
//   │   └── settings.mjs        ← new settings CRUD
//   ├── data/
//   │   └── settings.json       ← saved user settings (auto-created)
//   └── uploads/                ← your existing upload dir
