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
  apiKey:
    process.env.OPENAI_API_KEY ||
    "***REMOVED-SECRET***",
  baseURL: process.env.OPENAI_BASE_URL || "https://api.gapgpt.app/v1"
});

// -----------------------------------------------------------------------------
// WORKSPACE CONFIG
// -----------------------------------------------------------------------------
const APP_NAME = "login-app";
const APP_ROOT = path.join(WORKSPACE_ROOT, APP_NAME);
const DEV_PORT = 5173;
const DEV_URL = `http://localhost:${DEV_PORT}`;
const BOOTSTRAP_FLAG = path.join(WORKSPACE_ROOT, ".bootstrap_done");
const BOOTSTRAP_OUTPUT_DIR = path.join(WORKSPACE_ROOT, "bootstrap-output");
const HARD_MAX_STEPS =
  Number(process.env.AGENT_MAX_STEPS) ||
  Number(
    (process.argv.find(arg => arg.startsWith("--max-steps=")) || "")
      .split("=")[1]
  ) ||
  60; // مقدار پیش‌فرض

const MAX_HISTORY = 25;
const DIFF_THRESHOLD_PERCENT = 0.2;

const PRIMARY_REFERENCE_IMAGE = "reference_ui.png";

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
// MINIMAL FALLBACK APP (برای مواقعی که bootstrap یا edits خراب می‌شود)
// -----------------------------------------------------------------------------
const minimalValidAppJsx = `import React from "react";

export default function App() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100">
      <div className="p-8 bg-white shadow rounded-lg">
        <h1 className="text-xl font-semibold text-slate-900">
          Bootstrap UI ready
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          This is a fallback App.jsx used when generated code fails to build.
        </p>
      </div>
    </div>
  );
}
`;

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

  // Placeholder اولیه
  fs.writeFileSync(
    path.join(APP_ROOT, "src/App.jsx"),
    minimalValidAppJsx // ✅ از همون fallback استفاده می‌کنیم
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

// -----------------------------------------------------------------------------
// SAFE EDIT + BUILD VALIDATION
// -----------------------------------------------------------------------------
async function runBuild() {
  console.log("🔎 Running build validation (npm run build)...");
  const result = await runCommand({
    cwd: APP_NAME,
    cmd: "npm run build",
    env: TOOL_ENV
  });
  return result.success;
}

// فقط برای فایل‌هایی مثل src/App.jsx از این استفاده می‌کنیم
async function safeEditFileWithValidation(relPath, newContent) {
  const { fullPath } = resolveWorkspacePath(normalizeWorkspacePath(relPath));
  const dir = path.dirname(fullPath);

  fs.mkdirSync(dir, { recursive: true });

  let originalContent = "";
  if (fs.existsSync(fullPath)) {
    originalContent = fs.readFileSync(fullPath, "utf8");
    fs.writeFileSync(fullPath + ".bak", originalContent, "utf8");
  }

  fs.writeFileSync(fullPath, newContent, "utf8");

  const ok = await runBuild();

  if (!ok) {
    console.error(
      `❌ Edit broke the build for ${relPath}. Reverting to previous version.`
    );
    if (originalContent) {
      fs.writeFileSync(fullPath, originalContent, "utf8");
    } else {
      // اگر فایل جدید بود و قبلاً وجود نداشت
      fs.unlinkSync(fullPath);
    }
    return false;
  }

  console.log(`✅ Edit for ${relPath} passed build validation.`);
  return true;
}

// بعد از bootstrap، اگر build fail شد، fallback بنویس
async function ensureAppJsxBuildable() {
  const ok = await runBuild();
  if (ok) {
    console.log("✅ Bootstrap App.jsx passed build check.");
    return;
  }

  console.error(
    "❌ Bootstrap App.jsx failed build. Writing minimal fallback App.jsx..."
  );
  const relPath = "login-app/src/App.jsx";
  safeWrite(relPath, minimalValidAppJsx);

  const ok2 = await runBuild();
  if (!ok2) {
    console.error(
      "❌ Even fallback App.jsx failed build. Something is fundamentally wrong with the project."
    );
  } else {
    console.log("✅ Fallback App.jsx build succeeded.");
  }
}

// -----------------------------------------------------------------------------
// FIND RELEVANT FILES
// -----------------------------------------------------------------------------
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

  return results
    .map(abs => path.relative(WORKSPACE_ROOT, abs).replace(/\\/g, "/"));
}

// -----------------------------------------------------------------------------
// BOOTSTRAP FROM IMAGE (فاز صفر)
// -----------------------------------------------------------------------------
async function bootstrapUIFromImage() {
  const imagePath = path.join(WORKSPACE_ROOT, PRIMARY_REFERENCE_IMAGE);

  // اگر قبلاً bootstrap انجام شده، دوباره انجام نده
  if (fs.existsSync(BOOTSTRAP_FLAG)) {
    console.log(
      "⚠️ Bootstrap already done (flag file exists). Skipping bootstrap phase."
    );
    return;
  }

  if (!fs.existsSync(imagePath)) {
    console.log(
      `⚠️ No primary reference image found at ${imagePath}. Skipping bootstrap phase.`
    );
    return;
  }

  console.log(
    `🎬 Bootstrapping initial UI from reference image: ${PRIMARY_REFERENCE_IMAGE}`
  );

  try {
    const imageBuffer = fs.readFileSync(imagePath);
    const imageBase64 = imageBuffer.toString("base64");
    const dataUrl = `data:image/png;base64,${imageBase64}`;

    const systemPrompt = `
You are an expert frontend engineer and UI implementer.
You are given a reference UI design as an image.
Your job is to generate a complete React + TailwindCSS implementation
for the main application entry (App.jsx), matching the layout and visual
hierarchy as closely as possible.

Rules:
- Use React functional components.
- Use TailwindCSS utility classes for all styling.
- Use only valid Tailwind classes from the official docs (e.g. bg-blue-500, text-gray-700, hover:bg-blue-600, focus:outline-none, focus:ring-2).
- Do NOT invent classes like "hover-gl", "focus:hocusing", or incomplete classes like "focus:outline-", "bg", "text-gray", "border-", "shadow-".
- Always include a shade for gray colors (e.g. text-gray-700, not text-gray).
- All JSX must be syntactically valid, use a single default export React component, and have a single root element.
- Do NOT include any additional text explaining the code.
- Output ONLY the contents of App.jsx (no backticks, no extra commentary).
- Assume this file lives in src/App.jsx and is used by src/main.jsx.

CRITICAL OUTPUT RULES:
- You MUST NEVER return an empty response.
- If you are unsure, you MUST still produce a best-effort App.jsx.
- If the image is unclear, produce a reasonable skeleton UI that matches a typical login screen.
- Do NOT say "I cannot", "I am unsure", or any apology. Just output React code.

CRITICAL Tool Usage Rules:
- You MUST call at most ONE tool per assistant turn.
- NEVER call multiple tools in the same assistant message.
- If multiple tools are needed, call them SEQUENTIALLY:
  one assistant message → one tool call → wait for result → next assistant message → next tool call.
- Parallel or batch tool calls in a single message are NOT allowed in this environment.
- Strictly follow these tool usage constraints to avoid runtime errors and ensure agent stability.
`.trim();

    const completion = await client.chat.completions.create({
      model: "gpt-5.2",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Generate the full content of src/App.jsx that implements this screen using React and TailwindCSS."
            },
            {
              type: "image_url",
              image_url: {
                url: dataUrl
              }
            }
          ]
        }
      ],
      temperature: 0.2,
      max_tokens: 2000
    });

    const choice = completion?.choices?.[0];
    console.log(
      "🔍 Bootstrap raw choice:",
      JSON.stringify(choice, null, 2)
    );

    let appCode = choice?.message?.content ?? "";

    // اگر خالی بود، به جای skip، skeleton وارد کن
    if (!appCode.trim()) {
      console.log(
        "⚠️ Bootstrap model returned empty App.jsx. Falling back to skeleton login UI."
      );

      appCode = `import React from "react";

export default function App() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-black">
      <div className="w-full max-w-md mx-auto px-4">
        <div className="flex justify-center mb-10">
          {/* Placeholder for small triangle logo */}
          <div className="w-4 h-4 border-l-8 border-b-8 border-white rotate-45" />
        </div>

        <div className="bg-black/40 border border-zinc-800 rounded-2xl px-6 py-8 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]">
          <h1 className="text-center text-2xl font-medium text-white">
            Log in to Vercel
          </h1>

          <div className="mt-6 space-y-3">
            <input
              type="email"
              placeholder="Email Address"
              className="w-full rounded-xl border border-zinc-800 bg-black px-3 py-2.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-500"
            />

            <button
              className="w-full rounded-xl bg-white py-2.5 text-sm font-medium text-black hover:bg-zinc-100 transition"
            >
              Continue with Email
            </button>
          </div>

          <div className="mt-6 space-y-3">
            <button className="w-full flex items-center justify-center gap-2 rounded-xl border border-zinc-800 bg-black py-2.5 text-sm text-white hover:bg-zinc-900 transition">
              <span>Continue with GitHub</span>
              <span className="ml-auto mr-1 rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-300">
                Last Used
              </span>
            </button>
            <button className="w-full rounded-xl border border-zinc-800 bg-black py-2.5 text-sm text白 hover:bg-zinc-900 transition">
              Continue with Google
            </button>
            <button className="w-full rounded-xl border border-zinc-800 bg-black py-2.5 text-sm text白 hover:bg-zinc-900 transition">
              Continue with Apple
            </button>
            <button className="w-full rounded-xl border border-zinc-800 bg-black py-2.5 text-sm text白 hover:bg-zinc-900 transition">
              Continue with SAML SSO
            </button>
            <button className="w-full rounded-xl border border-zinc-800 bg-black py-2.5 text-sm text白 hover:bg-zinc-900 transition">
              Continue with Passkey
            </button>
          </div>

          <button className="mt-6 w-full text-center text-xs text-zinc-400 hover:text-zinc-200">
            Show other options
          </button>

          <p className="mt-4 text-center text-xs text-zinc-400">
            Don&apos;t have an account?{" "}
            <button className="text-zinc-100 underline-offset-2 hover:underline">
              Sign Up
            </button>
          </p>
        </div>

        <div className="mt-8 flex justify-center gap-4 text-[10px] text-zinc-500">
          <button className="hover:text-zinc-300">Terms</button>
          <button className="hover:text-zinc-300">Privacy Policy</button>
        </div>
      </div>
    </div>
  );
}
`;
    }

    // حذف

appCode = appCode.replace(/^```[a-zA-Z]*\s*/, "").replace(/```$/, "").trim();

// ذخیره نسخه‌ی خام برای دیباگ
fs.mkdirSync(BOOTSTRAP_OUTPUT_DIR, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const rawFile = path.join(
BOOTSTRAP_OUTPUT_DIR,
`App-bootstrap-${timestamp}.jsx`
);
fs.writeFileSync(rawFile, appCode, "utf8");
console.log(`📝 Saved raw bootstrap App.jsx to ${rawFile}`);

// نوشتن فایل اصلی
safeWrite("login-app/src/App.jsx", appCode);
console.log("✅ Bootstrapped src/App.jsx from reference image.");

// ✅ Validation بعد از bootstrap
await ensureAppJsxBuildable();

// فلگ بساز که دوباره bootstrap انجام نشود
fs.writeFileSync(
BOOTSTRAP_FLAG,
`bootstrap done at ${new Date().toISOString()}\n`,
"utf8"
);
  } catch (err) {
console.error("❌ Bootstrap from image failed:", err);
// اگر bootstrap شکست خورد، حداقل مطمئن شو fallback وجود داره
await ensureAppJsxBuildable();
  }
}

// -----------------------------------------------------------------------------
// ENFORCE TOOL CALL
// -----------------------------------------------------------------------------
function enforceToolCall(message, lastDiff) {
  if (!message.tool_calls) {
if (lastDiff === null || lastDiff > DIFF_THRESHOLD_PERCENT) {
console.log(
"❌ Invalid assistant message — missing tool_calls. Forcing continue..."
);
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
// PLANNING HELPER
// -----------------------------------------------------------------------------
async function generatePlanWithModel(contextText) {
  const systemPrompt = `
You are a senior frontend engineer acting as a PLANNER (not a coder) for a UI refinement agent.

Your job:
- Read the current situation (diff summary, vision analysis, existing files, etc.).
- Produce a SHORT, STRUCTURED JSON plan for one refinement iteration of the UI.
- The plan will then be executed by another tool that actually edits files.

Constraints:
- DO NOT write any code.
- DO NOT include JSX or Tailwind classes.
- Focus only on WHAT to change and WHY, at a high level.
- Keep the plan focused on 1–5 concrete, impactful changes.

Output format (MUST be valid JSON, no comments):

{
  "step_summary": "short human-readable description of this iteration's focus",
  "ready_for_user_review": false,
  "estimated_visual_gain": 0.0,
  "changes": [
{
"target_files": ["login-app/src/App.jsx"],
"reason": "why this change is needed",
"actions": [
"what to change conceptually, not code (e.g. 'make primary button match reference color and shape')"
]
}
  ]
}
  `.trim();

  const completion = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: systemPrompt },
{
role: "user",
content: contextText
}
],
temperature: 0.2,
max_tokens: 600
  });

  const content = completion.choices?.[0]?.message?.content || "{}";

  try {
const parsed = JSON.parse(content);
return JSON.stringify(parsed, null, 2);
  } catch {
return JSON.stringify(
{
parse_warning:
"Model returned non-JSON; returning raw content in 'raw' field.",
raw: content
},
null,
2
);
  }
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

case "create_file": {
// برای هر فایلی به‌صورت عادی بنویس، ولی اگر App.jsx بود، بعدش build check کن
safeWrite(call.arguments.path, call.arguments.content);
if (
call.arguments.path === "login-app/src/App.jsx" ||
call.arguments.path.endsWith("/src/App.jsx")
) {
await ensureAppJsxBuildable();
}
return JSON.stringify({ status: "ok", action: call.name }, null, 2);
}

case "edit_file": {
// ✅ برای App.jsx حتماً از safeEditFileWithValidation استفاده کن
if (
call.arguments.path === "login-app/src/App.jsx" ||
call.arguments.path.endsWith("/src/App.jsx")
) {
const ok = await safeEditFileWithValidation(
call.arguments.path,
call.arguments.content
);
return JSON.stringify(
{
status: ok ? "ok" : "reverted",
action: call.name
},
null,
2
);
} else {
// سایر فایل‌ها: فعلاً ساده، اما می‌تونی بعداً برای آنها هم همان منطق را بگذاری
safeWrite(call.arguments.path, call.arguments.content);
return JSON.stringify(
{ status: "ok", action: call.name },
null,
2
);
}
}

case "read_file":
return JSON.stringify({ content: safeRead(call.arguments.path) });

case "list_files":
return JSON.stringify(listFiles(call.arguments.path), null, 2);

case "find_relevant_files": {
const files = findRelevantFilesHeuristic(call.arguments.description);
return JSON.stringify({ matchedFiles: files }, null, 2);
}

case "bootstrap_ui_from_image": {
await bootstrapUIFromImage();
return JSON.stringify(
{ status: "ok", action: "bootstrap_ui_from_image" },
null,
2
);
}

case "plan_ui_step": {
const planJson = await generatePlanWithModel(call.arguments.context);
return planJson;
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

Your behavior is always THREE PHASES:

PHASE 0 — IMAGE-BASED BOOTSTRAP (NEW)
---------------------------------
If a reference UI image exists in the workspace (e.g. ${PRIMARY_REFERENCE_IMAGE}),
you MUST FIRST call the tool "bootstrap_ui_from_image" exactly once.
This tool will generate the initial src/App.jsx based on the design image.
Only after this bootstrap is complete, continue with Phase 1.

Important Tailwind rules:
- Use only valid Tailwind utility classes.
- Never invent classes like "hover-gl", "bg" alone, "focus:hocusing", or incomplete classes like "focus:outline-".
- Always include a shade for gray colors (e.g. text-gray-700, not text-gray).

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
capture_ui → diff_ui → vision_analyze_ui → find_relevant_files → plan_ui_step → edit_file → repeat
until diffPercent <= ${DIFF_THRESHOLD_PERCENT}%.

Detailed loop:
1. Call capture_ui to grab the current UI.
2. Call diff_ui to compare it with the reference image.
3. If diffPercent > ${DIFF_THRESHOLD_PERCENT}%:
   a. Call vision_analyze_ui to get a visual, semantic description of the differences.
   b. Call find_relevant_files with a textual description of what needs to change.
   c. Call plan_ui_step with a rich natural-language context (diff summary + vision analysis + list of relevant files). This MUST produce a JSON plan of what to change and why.
   d. Based on that plan, call edit_file (or create_file) to apply minimal, focused changes.
   e. Then repeat from step 1.
4. If diffPercent <= ${DIFF_THRESHOLD_PERCENT}%:
   - stop with a normal assistant message (no tool calls).

Rules:
1. NEVER stop early.
2. During Phase 2, you MUST always follow the planning pattern:
   vision_analyze_ui → find_relevant_files → plan_ui_step → edit_file.
3. NEVER call edit_file without having called plan_ui_step in a recent step with context for this iteration.
4. EVERY assistant message MUST contain exactly ONE tool_call during Phase 2.
5. After any edit, always repeat capture → diff.

You are not allowed to end the workflow until Phase 2 finishes successfully.
`;

const TASK = `
Your goal is threefold:

PHASE 0 — If a reference UI image exists, bootstrap the initial App.jsx from it
by calling "bootstrap_ui_from_image" once at the very beginning.

PHASE 1 — Implement the user's requested UI or functionality.
Make sure the UI exists in the project and behaves as requested.
Use create_file, read_file, and edit_file as needed.
When the UI is functionally correct, transition to Phase 2.

PHASE 2 — Pixel-perfect reconstruction:
Use a PLAN → APPLY pattern in each iteration:
Loop:
1. capture_ui(${DEV_URL})
2. diff_ui(reference_ui.png vs current_ui.png)
3. If diff > ${DIFF_THRESHOLD_PERCENT}:
   - run vision_analyze_ui
   - run find_relevant_files
   - generate a structured JSON plan via plan_ui_step
   - apply minimal edits via edit_file based on that plan
   - return to step 1
4. If diff <= ${DIFF_THRESHOLD_PERCENT}:
   - stop with a normal assistant message (no tool calls)

BEGIN NOW.
If UI does not exist yet, start with Phase 0 (if image present) then Phase 1.
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
  },
  {
type: "function",
function: {
name: "bootstrap_ui_from_image",
description:
"Generate the initial src/App.jsx based on the primary reference UI image (e.g. reference_ui.png). Must be called at most once at the beginning if the image exists.",
parameters: {
type: "object",
properties: {},
required: []
}
}
  },
  {
type: "function",
function: {
name: "plan_ui_step",
description:
"Generate a structured plan for the next UI refinement step before editing files. Returns a JSON plan describing what to change and why. This tool does NOT apply changes itself.",
parameters: {
type: "object",
properties: {
context: {
type: "string",
description:
"Natural-language description of current UI, diff summary, and goals for this step."
}
},
required: ["context"]
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

  while (tail.length && tail[0].role === "tool") {
tail.shift();
  }

  return [...head, ...tail];
}

// -----------------------------------------------------------------------------
// HISTORY VALIDATION
// -----------------------------------------------------------------------------
function validateHistory(history) {
  for (let i = 0; i < history.length; i++) {
const msg = history[i];

if (msg.role !== "tool") continue;

const prev = history[i - 1];

if (!prev) {
throw new Error("Tool message cannot be first message.");
}

if (prev.role !== "assistant") {
throw new Error(
"Tool message must come immediately after an assistant message."
);
}

if (!prev.tool_calls || prev.tool_calls.length === 0) {
throw new Error(
"Tool message appears but assistant message had no tool_calls."
);
}

const matches = prev.tool_calls.some(tc => tc.id === msg.tool_call_id);

if (!matches) {
throw new Error(
`Tool message tool_call_id=${msg.tool_call_id} does not match any assistant tool_calls.`
);
}
  }
}

// -----------------------------------------------------------------------------
// MAIN LOOP
// -----------------------------------------------------------------------------
async function run() {
  let serverProc;
  
  try {
await ensureProjectExists();
await ensureDependenciesInstalled();
serverProc = startServer();

await waitForServer(DEV_URL);
console.log(`🚀 Dev server ready at ${DEV_URL}`);

// Phase 0: Bootstrap (idempotent)
await bootstrapUIFromImage();

let history = [
{ role: "system", content: SYSTEM },
{ role: "user", content: TASK }
];

let lastDiff = null;
let plannerReadyForReview = false;
for (let step = 1; step <= HARD_MAX_STEPS; step++) {
  console.log(`\n🌀 Step ${step} / ${HARD_MAX_STEPS}`);

// Validate history قبل از ارسال
validateHistory(history);

// MODEL CALL
const completion = await client.chat.completions.create({
model: "gpt-4o",
messages: history,
tools,
tool_choice: "auto"
});

let msg = completion.choices[0].message;

// If model failed policy, enforce a tool call
msg = enforceToolCall(msg, lastDiff);

// ⚠️ Ensure ONLY ONE tool call is kept
if (msg.tool_calls && msg.tool_calls.length > 1) {
console.warn(
"⚠️ Model returned multiple tool calls. Keeping only the first one."
);
msg.tool_calls = [msg.tool_calls[0]];
}

history.push(msg);

// If there is no tool call, agent believes job is done
if (!msg.tool_calls || msg.tool_calls.length === 0) {
console.log("🏁 Assistant ended the workflow.");
break;
}

// IMPORTANT FIX:
// Only run ONE tool per assistant turn
const call = msg.tool_calls[0];

console.log(`⚙️ Running tool: ${call.function.name}`);

// Parse args
const args = call.function.arguments
? JSON.parse(call.function.arguments)
: {};

// Execute tool
const result = await executeTool({
name: call.function.name,
arguments: args
});

if (call.function.name === "plan_ui_step") {
  console.log("🧠 Planning step JSON:");
  console.log(result);

  try {
    const parsedPlan = JSON.parse(result);
    if (typeof parsedPlan.ready_for_user_review === "boolean") {
      plannerReadyForReview = parsedPlan.ready_for_user_review;
    }
  } catch (err) {
    console.warn("⚠️ Failed to parse planning JSON:", err.message);
  }
}


// Update diff if tool was diff_ui
if (call.function.name === "diff_ui") {
try {
lastDiff = JSON.parse(result);
} catch {
/* ignore parse errors */
}
}

// Push tool result to history
history.push({
role: "tool",
tool_call_id: call.id,
content: result
});

// If diff small enough, stop
// If diff small enough, stop
if (lastDiff && lastDiff.diffPercent <= DIFF_THRESHOLD_PERCENT) {
  console.log(
    `🎉 Pixel diff ${lastDiff.diffPercent}% is under threshold (${DIFF_THRESHOLD_PERCENT}). Finished.`
  );
  break;
}

// If planner says it's ready for user review, stop as well
if (plannerReadyForReview) {
  console.log(
    "✅ Planner marked ready_for_user_review = true. Stopping refinement loop."
  );
  break;
}

// Trim history to avoid overflow
history = trimHistory(history, MAX_HISTORY);

}

if (!plannerReadyForReview && (!lastDiff || lastDiff.diffPercent > DIFF_THRESHOLD_PERCENT)) {
  console.warn(
    `⚠️ Reached HARD_MAX_STEPS=${HARD_MAX_STEPS} without meeting diff threshold or plannerReadyForReview=true.`
  );
}

  } catch (err) {
console.error("❌ Agent crashed:", err);
  } finally {
console.log("🛑 Stopping dev server...");
stopDevServer();
  }
}

run();
