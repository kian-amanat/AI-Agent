// agent.js — AUTONOMOUS PIXEL‑PERFECT SELF‑HEALING AGENT

import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import dotenv from "dotenv";

import {
  WORKSPACE_ROOT,
  resolveWorkspacePath,
  normalizeWorkspacePath
} from "./tools/workspace_utils.js";

import { analyzeUIWithDiff } from "./tools/visionTools.js";
import { captureUI } from "./tools/capture.js";
import { diffUI } from "./tools/diff.js";
import { waitForServer, stopDevServer } from "./tools/server.js";
import { runCommand } from "./tools/runCommand.js";

dotenv.config();

// -----------------------------------------------------------------------------
// OPENAI CLIENT
// -----------------------------------------------------------------------------
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "sk-KYVx0aFzK7YxQ9Y1E6IvRFDfyfx2G3brRW6wJYNyJ7o9AWAx",
  baseURL: process.env.OPENAI_BASE_URL || "https://api.gapgpt.app/v1"
});

// -----------------------------------------------------------------------------
// WORKSPACE CONFIG
// -----------------------------------------------------------------------------
const APP_NAME = "login-app";
const APP_ROOT = path.join(WORKSPACE_ROOT, APP_NAME);
const DEV_PORT = 5173;
const DEV_URL = `http://localhost:${DEV_PORT}`;

const MAX_STEPS = 40;
const MAX_HISTORY = 25;
const DIFF_THRESHOLD_PERCENT = 0.2;

// -----------------------------------------------------------------------------
// ENV FIX
// -----------------------------------------------------------------------------
const NODE_BIN_DIR = process.env.NODE_BIN_DIR;
if (!NODE_BIN_DIR) {
  console.error("❌ Missing NODE_BIN_DIR in .env");
  process.exit(1);
}

const TOOL_ENV = {
  ...process.env,
  PATH: `${NODE_BIN_DIR}:${process.env.PATH}`
};

// -----------------------------------------------------------------------------
// PROJECT CREATION
// -----------------------------------------------------------------------------
async function ensureProjectExists() {
  if (!fs.existsSync(WORKSPACE_ROOT)) {
    fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  }

  if (fs.existsSync(APP_ROOT)) {
    console.log(`✅ Project exists at ${APP_ROOT}`);
    return;
  }

  console.log(`🧱 Creating Vite React app at ${APP_ROOT} ...`);
  fs.mkdirSync(APP_ROOT, { recursive: true });
  fs.mkdirSync(path.join(APP_ROOT, "src"), { recursive: true });

  fs.writeFileSync(
    path.join(APP_ROOT, "package.json"),
    JSON.stringify(
      {
        name: APP_NAME,
        version: "1.0.0",
        scripts: {
          dev: "npx --no-install vite",
          build: "npx --no-install vite build",
          preview: "npx --no-install vite preview"
        },
        dependencies: {
          react: "^18.2.0",
          "react-dom": "^18.2.0"
        },
        devDependencies: {
          vite: "^4.1.0",
          "@vitejs/plugin-react": "^3.1.0",
          tailwindcss: "^3.3.2",
          autoprefixer: "^10.4.0",
          postcss: "^8.4.0"
        }
      },
      null,
      2
    )
  );

  fs.writeFileSync(
    path.join(APP_ROOT, "vite.config.js"),
    `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()] });`
  );

  fs.writeFileSync(
    path.join(APP_ROOT, "index.html"),
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${APP_NAME}</title>
  <link href="/src/index.css" rel="stylesheet" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.jsx"></script>
</body>
</html>`
  );

  fs.writeFileSync(
    path.join(APP_ROOT, "src/main.jsx"),
    `import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode><App /></React.StrictMode>
);`
  );

  fs.writeFileSync(
    path.join(APP_ROOT, "src/App.jsx"),
    `import React from "react";
export default function App() {
  return (
    <div className="p-4 max-w-xl mx-auto">
      <h1 className="text-3xl font-bold mb-4">Login App</h1>
      <p>Welcome to the automated Vite React + TailwindCSS app!</p>
    </div>
  );
}`
  );

  fs.writeFileSync(
    path.join(APP_ROOT, "src/index.css"),
    `@tailwind base;
@tailwind components;
@tailwind utilities;`
  );

  fs.writeFileSync(
    path.join(APP_ROOT, "tailwind.config.js"),
    `module.exports = {
      content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
      theme: { extend: {} },
      plugins: [],
    };`
  );

  fs.writeFileSync(
    path.join(APP_ROOT, "postcss.config.js"),
    `module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };`
  );

  console.log("📦 Installing dependencies...");
  const result = await runCommand({
    cwd: APP_NAME,
    cmd: "npm install --include=dev",
    env: TOOL_ENV
  });

  if (!result.success) throw new Error("npm install failed");
  console.log("✅ Project ready.");
}

// -----------------------------------------------------------------------------
// ENSURE DEPENDENCIES
// -----------------------------------------------------------------------------
async function ensureDependenciesInstalled() {
  console.log("📦 Ensuring dependencies...");
  const check = await runCommand({
    cwd: APP_NAME,
    cmd: 'test -d node_modules && node -e "require(\'vite\')"',
    env: TOOL_ENV
  });
  if (check.success) {
    console.log("✅ node_modules OK.");
    return;
  }

  const install = await runCommand({
    cwd: APP_NAME,
    cmd: "npm install --include=dev",
    env: TOOL_ENV
  });

  if (!install.success) throw new Error("npm install failed");
  console.log("✅ Dependencies installed.");
}

// -----------------------------------------------------------------------------
// DEV SERVER
// -----------------------------------------------------------------------------
function startServer() {
  console.log("🚀 Starting dev server...");
  const proc = spawn("npx", ["vite", "--port", DEV_PORT.toString()], {
    cwd: APP_ROOT,
    env: TOOL_ENV,
    stdio: "inherit"
  });
  return proc;
}

// -----------------------------------------------------------------------------
// FILE TOOLS
// -----------------------------------------------------------------------------
function safeWrite(relPath, content) {
  const { fullPath } = resolveWorkspacePath(normalizeWorkspacePath(relPath));
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
}

function safeRead(relPath) {
  const { fullPath } = resolveWorkspacePath(normalizeWorkspacePath(relPath));
  return fs.readFileSync(fullPath, "utf8");
}

function listFiles(relPath) {
  const { fullPath } = resolveWorkspacePath(normalizeWorkspacePath(relPath));
  return fs.readdirSync(fullPath);
}

function findRelevantFilesHeuristic(diffText) {
  const SRC_ROOT = path.join(APP_ROOT, "src");
  const results = [];

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(jsx?|tsx?)$/.test(e.name)) {
        const content = fs.readFileSync(full, "utf8").toLowerCase();
        const score =
          (content.includes("button") && diffText.includes("button")) ||
          (content.includes("input") && diffText.includes("input")) ||
          /login|email|password/.test(content + diffText);
        if (score) results.push(full);
      }
    }
  }

  if (fs.existsSync(SRC_ROOT)) walk(SRC_ROOT);

  return results.map((abs) =>
    path.relative(WORKSPACE_ROOT, abs).replace(/\\/g, "/")
  );
}




function enforceToolCall(message, lastDiff) {
  // If workflow hasn't reached success condition,
  // ANY assistant message without tool_calls is INVALID
  if (!message.tool_calls) {
    if (lastDiff === null || lastDiff > DIFF_THRESHOLD_PERCENT) {
      console.log("❌ Invalid assistant message — missing tool_calls. Forcing continue...");
      return {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: `force_retry_${Date.now()}`,
            type: "function",
            function: {
              name: "capture_ui",
              arguments: JSON.stringify({ url: DEV_URL })
            }
          }
        ]
      };
    }
  }

  return message;
}



// -----------------------------------------------------------------------------
// TOOL EXECUTOR
// -----------------------------------------------------------------------------
async function executeTool(call) {
  try {
    switch (call.name) {
      case "capture_ui":
        return JSON.stringify(
          await captureUI({ url: call.arguments.url }),
          null,
          2
        );

      case "diff_ui": {
        const out = await diffUI({
          reference: call.arguments.reference,
          current: call.arguments.current,
          diffOut: call.arguments.diffOut,
          threshold: call.arguments.threshold
        });
        return JSON.stringify(out, null, 2);
      }

      case "vision_analyze_ui": {
        const out = await analyzeUIWithDiff({
          referencePath: path.join(
            WORKSPACE_ROOT,
            call.arguments.referencePath
          ),
          currentPath: path.join(
            WORKSPACE_ROOT,
            call.arguments.currentPath
          ),
          diffPath: path.join(WORKSPACE_ROOT, call.arguments.diffPath)
        });
        return JSON.stringify({ visionAnalysis: out }, null, 2);
      }

      case "create_file":
      case "edit_file":
        safeWrite(call.arguments.path, call.arguments.content);
        return JSON.stringify({ status: "ok", action: call.name }, null, 2);

      case "read_file":
        return JSON.stringify({ content: safeRead(call.arguments.path) });

      case "list_files":
        return JSON.stringify(listFiles(call.arguments.path), null, 2);

      case "find_relevant_files": {
        const files = findRelevantFilesHeuristic(call.arguments.description);
        return JSON.stringify({ matchedFiles: files }, null, 2);
      }
    }
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}

// -----------------------------------------------------------------------------
// PROMPTS
// -----------------------------------------------------------------------------
const SYSTEM = `
You are an autonomous frontend engineer.

Your behavior is always TWO PHASES:

PHASE 1 — UI CREATION
---------------------------------
Based on the user's request, you MUST create or modify the UI
until the basic structure, components, and layout exist.
Use create_file, read_file, and edit_file to build the UI.

You MUST NOT enter pixel comparison yet.
Only when the UI exists and implements the user's functional request,
move to Phase 2.

PHASE 2 — PIXEL RECONSTRUCTION LOOP
---------------------------------
Your mission is to match the UI to reference_ui.png with pixel perfection.

You MUST iterate:
capture_ui → diff_ui → vision_analyze_ui → find_relevant_files → edit_file → repeat
until diffPercent <= ${DIFF_THRESHOLD_PERCENT}%.

Rules:
1. NEVER stop early.
2. NEVER produce a normal assistant message unless diff <= threshold.
3. EVERY assistant message MUST contain tool_calls during Phase 2.
4. After any edit, always repeat capture → diff.
5. If unsure what to do, continue the loop.

You are not allowed to end the workflow until Phase 2 finishes successfully.
`;




const TASK = `
Your goal is twofold:

PHASE 1 — Implement the user's requested UI or functionality.
Make sure the UI exists in the project and behaves as requested.
Use create_file, read_file, and edit_file as needed.
When the UI is functionally correct, transition to Phase 2.

PHASE 2 — Pixel-perfect reconstruction:
Loop:
1. capture_ui(${DEV_URL})
2. diff_ui(reference_ui.png vs current_ui.png)
3. If diff > ${DIFF_THRESHOLD_PERCENT}:
   - run vision_analyze_ui
   - run find_relevant_files
   - apply minimal edits via edit_file
   - return to step 1
4. If diff <= ${DIFF_THRESHOLD_PERCENT}:
   - stop with a normal assistant message (no tool calls)

BEGIN NOW.
If UI does not exist yet, start with Phase 1.
If UI exists, jump directly to Phase 2.
`;




// -----------------------------------------------------------------------------
// TOOL SCHEMA
// -----------------------------------------------------------------------------
const tools = [
  {
    type: "function",
    function: {
      name: "capture_ui",
      description: "Capture current UI.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "diff_ui",
      description: "Compute pixel diff.",
      parameters: {
        type: "object",
        properties: {
          reference: { type: "string" },
          current: { type: "string" },
          diffOut: { type: "string" },
          threshold: { type: "number" }
        },
        required: ["reference", "current", "diffOut", "threshold"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "vision_analyze_ui",
      description: "Describe visual difference.",
      parameters: {
        type: "object",
        properties: {
          referencePath: { type: "string" },
          currentPath: { type: "string" },
          diffPath: { type: "string" }
        },
        required: ["referencePath", "currentPath", "diffPath"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_file",
      description: "Create a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Edit a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "find_relevant_files",
      description: "Find likely source files to edit.",
      parameters: {
        type: "object",
        properties: { description: { type: "string" } },
        required: ["description"]
      }
    }
  }
];


// -----------------------------------------------------------------------------
// SAFE HISTORY TRIMMING
// -----------------------------------------------------------------------------
function trimHistory(history, max) {
  if (history.length <= max) return history;

  const head = history.slice(0, 2); // keep system + user
  let tail = history.slice(-(max - 2));

  // ensure history never starts with a tool message
  while (tail.length && tail[0].role === "tool") {
    tail.shift();
  }

  return [...head, ...tail];
}

// -----------------------------------------------------------------------------
// HISTORY VALIDATION (prevents OpenAI tool ordering errors)
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// ROBUST HISTORY VALIDATION (final production version)
// -----------------------------------------------------------------------------
function validateHistory(history) {
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];

    // Only tool messages need validation
    if (msg.role !== "tool") continue;

    const prev = history[i - 1];

    // If no previous message → invalid
    if (!prev) {
      throw new Error("Tool message cannot be first message.");
    }

    // PREV MUST be assistant
    if (prev.role !== "assistant") {
      throw new Error(
        "Tool message must come immediately after an assistant message."
      );
    }

    // PREV MUST contain tool_calls
    if (!prev.tool_calls || prev.tool_calls.length === 0) {
      throw new Error(
        "Tool message appears but assistant message had no tool_calls."
      );
    }

    // Tool MUST match one of the assistant tool_call ids
    const matches = prev.tool_calls.some(tc => tc.id === msg.tool_call_id);

    if (!matches) {
      throw new Error(
        `Tool message tool_call_id=${msg.tool_call_id} does not match any assistant tool_calls.`
      );
    }
  }
}



// -----------------------------------------------------------------------------
// MAIN LOOP — ⭐ FIXED VERSION ⭐
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// MAIN LOOP — ⭐ FULLY FIXED VERSION ⭐
// -----------------------------------------------------------------------------
async function run() {
  let serverProc;

  try {
    await ensureProjectExists();
    await ensureDependenciesInstalled();
    serverProc = startServer();

    await waitForServer(DEV_URL);
    console.log(`🚀 Dev server ready at ${DEV_URL}`);

    let history = [
      { role: "system", content: SYSTEM },
      { role: "user", content: TASK }
    ];

    let lastDiff = null;

    for (let step = 1; step <= MAX_STEPS; step++) {
      console.log(`\n🌀 Step ${step} / ${MAX_STEPS}`);

      validateHistory(history);
      const completion = await client.chat.completions.create({
        model: "gpt-4o",
        messages: history,
        tools,
        tool_choice: "auto"
      });

      let msg = completion.choices[0].message;

      // Force tool-calls if needed
      msg = enforceToolCall(msg, lastDiff);

      // Store assistant message WITH tool_calls
      history.push(msg);

      // If no tool calls → done
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        console.log("🏁 Assistant ended the workflow.");
        break;
      }

      // Execute tools in correct order
      for (const call of msg.tool_calls) {
        console.log(`⚙️ Running tool: ${call.function.name}`);

        const args = call.function.arguments
          ? JSON.parse(call.function.arguments)
          : {};

        const result = await executeTool({
          name: call.function.name,
          arguments: args
        });

        // Special diff tracking
        if (call.function.name === "diff_ui") {
          try {
            lastDiff = JSON.parse(result);
          } catch {}
        }

        // Push tool response EXACTLY AFTER tool_calls
        history.push({
          role: "tool",
          tool_call_id: call.id,
          content: result
        });

        // ❌ DO NOT push any assistant messages here
        // The next assistant message must come from the model itself
      }

      // Stop if diff small
      if (lastDiff && lastDiff.diffPercent <= DIFF_THRESHOLD_PERCENT) {
        console.log(
          `🎉 Pixel diff ${lastDiff.diffPercent}% is under threshold. Finished.`
        );
        break;
      }

      // Trim history safely (never remove the system or initial user message)
 history = trimHistory(history, MAX_HISTORY);

    }
  } catch (err) {
    console.error("❌ Agent crashed:", err);
  } finally {
    console.log("🛑 Stopping dev server...");
    stopDevServer();
  }
}

run();


