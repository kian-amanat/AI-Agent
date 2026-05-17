import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import dotenv from "dotenv";

import {
  WORKSPACE_ROOT,
  resolveWorkspacePath,
  normalizeWorkspacePath,
} from "./tools/workspace_utils.js";

import { runCommand } from "./tools/runCommand.js";
import {
  analyzeScreenshotAdvanced,
  analyzeUIWithDiff,
} from "./tools/visionTools.js";

import { captureUI } from "./tools/capture.js";

dotenv.config();

// -----------------------------------------------------------------------------
// SAFETY: require key from env
// -----------------------------------------------------------------------------
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY in environment (.env).");
  process.exit(1);
}

// -----------------------------------------------------------------------------
// OPENAI CLIENT
// -----------------------------------------------------------------------------
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "***REMOVED-SECRET***",
  baseURL: process.env.OPENAI_BASE_URL || "https://api.gapgpt.app/v1",
});

// -----------------------------------------------------------------------------
// WORKSPACE CONFIG
// -----------------------------------------------------------------------------
const APP_NAME = "chatbot-app";
const APP_ROOT = path.join(WORKSPACE_ROOT, APP_NAME);
const DEV_PORT = 5173;
const DEV_URL = `http://localhost:${DEV_PORT}`;
const PRIMARY_REFERENCE_IMAGE = "reference_ui.png";
const GENERATED_SHOT = "generated_ui.png";
const DIFF_IMAGE = "ui_diff.png";

// Models
const VISION_MODEL = process.env.VISION_MODEL || "gpt-5.2";
const CODE_MODEL = process.env.CODE_MODEL || "gpt-5.3-codex"; // پیشنهاد: 4o برای JSON تمیزتر

// ⚙️ تعداد iteration قابل تنظیم (برای کنترل هزینه)
const REFINEMENT_ITERATIONS = Number(
  process.env.REFINEMENT_ITERATIONS || "1" // پیش‌فرض: فقط ۲ iteration
);

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
  PATH: `${NODE_BIN_DIR}:${process.env.PATH}`,
};

// -----------------------------------------------------------------------------
// MINIMAL FALLBACK APP
// -----------------------------------------------------------------------------
const fallbackAppJsx = `import React from "react";
import Layout from "./components/Layout";

export default function App() {
  return <Layout />;
}
`;

const fallbackLayoutJsx = `import React from "react";

export default function Layout() {
  return (
    <div className="min-h-screen bg-neutral-900 text-neutral-50 flex items-center justify-center">
      <div className="border border-neutral-800 rounded-2xl px-6 py-4 bg-neutral-900/80 max-w-md w-full text-center space-y-3">
        <h1 className="text-lg font-semibold">Chatbot UI Bootstrap</h1>
        <p className="text-sm text-neutral-400">
          Bootstrap failed. This is a minimal fallback layout.
        </p>
      </div>
    </div>
  );
}
`;

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------
function safeWrite(relPath, content) {
  const { fullPath } = resolveWorkspacePath(normalizeWorkspacePath(relPath));
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
}

function extractTextContent(msg) {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

function stripFences(s) {
  if (!s) return "";
  return s
    .replace(/```json\s*/gi, "")
.replace(/```javascript\s*/gi, "")
    .replace(/```js\s*/gi, "")
.replace(/```\s*/gi, "")
    .trim();
}

function extractFirstJsonBlock(text) {
  if (!text) return "";
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return text;
  }
  return text.slice(firstBrace, lastBrace + 1);
}

function prettyJson(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return "{}";
  }
}

// Robust JSON recovery: چند استراتژی برای پارس JSON از خروجی مدل
function tryParseJsonMulti(raw) {
  if (!raw || !raw.trim()) return { ok: false, error: new Error("empty") };

  const candidates = [];

  // 1) خام
  candidates.push(raw);

  // 2) تمیزشده از code fences
  const cleaned = stripFences(raw);
  candidates.push(cleaned);

  // 3) بلاک {...} با مچ کردن براکت‌ها
  function extractJsonByBraces(text) {
    const start = text.indexOf("{");
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }
    return null;
  }
  const braceBlock = extractJsonByBraces(cleaned);
  if (braceBlock) candidates.push(braceBlock);

  // 4) اگر

  const jsonBlockMatch = raw.match(/```json([\s\S]*?)```/i);
  if (jsonBlockMatch && jsonBlockMatch[1]) {
candidates.push(jsonBlockMatch[1].trim());
  }

  let lastError = null;
  for (const cand of candidates) {
if (!cand || !cand.trim()) continue;
try {
const parsed = JSON.parse(cand);
return { ok: true, value: parsed };
} catch (err) {
lastError = err;
}
  }

  return { ok: false, error: lastError || new Error("Unknown JSON parse error") };
}

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
  fs.mkdirSync(path.join(APP_ROOT, "src", "components"), { recursive: true });
  fs.mkdirSync(path.join(APP_ROOT, "src", "components", "ui"), {
recursive: true,
  });
  fs.mkdirSync(path.join(APP_ROOT, "src", "lib"), { recursive: true });

  fs.writeFileSync(
path.join(APP_ROOT, "package.json"),
JSON.stringify(
{
name: APP_NAME,
version: "1.0.0",
scripts: {
dev: "npx --no-install vite",
build: "npx --no-install vite build",
preview: "npx --no-install vite preview",
test: 'echo "no tests"',
},
dependencies: {
react: "^18.2.0",
"react-dom": "^18.2.0",
"lucide-react": "^0.454.0",
},
devDependencies: {
vite: "^4.1.0",
"@vitejs/plugin-react": "^3.1.0",
tailwindcss: "^3.3.2",
autoprefixer: "^10.4.0",
postcss: "^8.4.0",
"tailwind-merge": "^2.2.0",
},
},
null,
2
)
  );

  fs.writeFileSync(
path.join(APP_ROOT, "vite.config.js"),
`import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  resolve: {
alias: {
"@": "/src",
},
  },
});`
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
<body class="bg-neutral-900">
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
  <React.StrictMode>
<App />
  </React.StrictMode>
);`
  );

  fs.writeFileSync(
path.join(APP_ROOT, "src/index.css"),
`@tailwind base;
@tailwind components;
@tailwind utilities;

html, body, #root { height: 100%; }
body { @apply bg-neutral-900 text-neutral-50; }
`
  );

  fs.writeFileSync(
path.join(APP_ROOT, "tailwind.config.js"),
`module.exports = {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
extend: {
boxShadow: {
"soft-inner": "inset 0 0 0 1px rgba(148, 163, 184, 0.20)",
},
},
  },
  plugins: [],
};`
  );

  fs.writeFileSync(
path.join(APP_ROOT, "postcss.config.js"),
`module.exports = {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};`
  );

  fs.writeFileSync(
path.join(APP_ROOT, "src/lib/utils.js"),
`export function cn(...classes) {
  return classes.filter(Boolean).join(" ");
}
`
  );

  fs.writeFileSync(
path.join(APP_ROOT, "src/components/ui/button.jsx"),
`import * as React from "react";
import { cn } from "@/lib/utils";

export function Button({ className, variant = "default", size = "default", ...props }) {
  const base =
"inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ring-offset-neutral-900 disabled:pointer-events-none disabled:opacity-50 cursor-pointer";
  const variants = {
default: "bg-[#fb7185] text-white hover:bg-[#f9738f]",
ghost: "bg-transparent hover:bg-white/5 text-neutral-200",
outline: "border border-[#272727] bg-transparent hover:bg-white/5 text-neutral-200",
subtle: "bg-neutral-800 text-neutral-100 hover:bg-neutral-700",
secondary: "bg-neutral-800 text-neutral-100 hover:bg-neutral-700",
  };
  const sizes = {
default: "h-9 px-4 py-2",
sm: "h-8 px-3",
lg: "h-10 px-6",
icon: "h-9 w-9",
xs: "h-7 px-2 text-xs",
  };
  return (
<button
type={props.type || "button"}
className={cn(base, variants[variant], sizes[size], className)}
{...props}
/>
  );
}
`
  );

  fs.writeFileSync(
path.join(APP_ROOT, "src/components/ui/input.jsx"),
`import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef(function Input(
  { className, type = "text", ...props },
  ref
) {
  return (
<input
type={type}
ref={ref}
className={cn(
"flex h-9 w-full rounded-md border border-[#272727] bg-neutral-900 px-3 py-1 text-sm text-neutral-100 shadow-sm outline-none ring-offset-neutral-900 placeholder:text-neutral-500 focus-visible:ring-2 focus-visible:ring-[#fb7185] focus-visible:ring-offset-2",
className
)}
{...props}
/>
  );
});
`
  );

  fs.writeFileSync(
path.join(APP_ROOT, "src/components/ui/scroll-area.jsx"),
`import * as React from "react";
import { cn } from "@/lib/utils";

export function ScrollArea({ className, children }) {
  return (
<div className={cn("relative overflow-hidden", className)}>
<div className="h-full w-full overflow-y-auto scrollbar-thin scrollbar-thumb-neutral-700 scrollbar-track-transparent">
{children}
</div>
</div>
  );
}
`
  );

  safeWrite("chatbot-app/src/App.jsx", fallbackAppJsx);
  safeWrite("chatbot-app/src/components/Layout.jsx", fallbackLayoutJsx);

  console.log("📦 Installing dependencies...");
  const result = await runCommand({
cwd: APP_NAME,
cmd: "npm install --include=dev",
env: TOOL_ENV,
  });

  if (!result.success) throw new Error("npm install failed");
  console.log("✅ Project ready.");
}

// -----------------------------------------------------------------------------
// DEV SERVER
// -----------------------------------------------------------------------------
function startServer() {
  console.log("🚀 Starting dev server...");
  const child = spawn("npx", ["vite", "--port", DEV_PORT.toString()], {
cwd: APP_ROOT,
env: TOOL_ENV,
stdio: "inherit",
  });
  return child;
}

// -----------------------------------------------------------------------------
// CODEGEN FROM layoutSpec (robust JSON parsing)
// -----------------------------------------------------------------------------
async function generateCodeFromLayoutSpec(layoutSpec) {
  const systemPrompt = `
You are an expert frontend engineer implementing a fullscreen chatbot UI
using React, TailwindCSS, and shadcn-like primitives.

You must:
- Implement both the visual layout AND core interactions (sidebar collapse, settings modal, message action buttons, input behavior).
- Produce valid React (no TypeScript, no syntax errors).
- Return ONLY a single JSON object, no extra text, no explanations.
`.trim();

  const ls = layoutSpec || {};
  const sidebar = ls.sidebar || {};
  const colors = ls.colors || {};

  const userPrompt = `
layoutSpec (single source of truth for numeric layout and colors):
${prettyJson(ls)}

Core behavior requirements (implement these in the generated code):

1) Sidebar collapse:
   - There must be a collapse/expand button.
   - Clicking toggles a boolean state (e.g., isSidebarCollapsed).
   - When collapsed: sidebar becomes hidden or very narrow, main chat area expands.
   - When expanded: sidebar width ~= ${sidebar.width || 320}px.

2) Settings modal:
   - A settings trigger (e.g. button/icon) in the sidebar footer.
   - Clicking opens a modal centered on screen with dark overlay.
   - Modal has close button and clicking overlay or close closes it.

3) Chat message action buttons:
   - Under assistant messages: small buttons like "Copy", "Regenerate", "Like".
   - Each calls a stub handler (console.log or updating local state).

4) Input bar:
   - Controlled input with local state.
   - Enter key or send button click:
- If value.trim() is non-empty, call onSend(value) and clear input.
   - Visually: pill-shaped bar, send button on the right, matching layoutSpec.

UI structure to implement (files):

- src/App.jsx: root app, full-screen layout, render <Layout />.
- src/components/Layout.jsx: main flex split (ChatArea left, Sidebar right). Responsible for sidebar collapse state and settings modal state.
- src/components/Sidebar.jsx: right panel with title, "New Chat", search, conversation list, footer settings button.
- src/components/ChatHeader.jsx: minimal header for chat area.
- src/components/ChatArea.jsx: manages messages + wiring InputBar and MessageList.
- src/components/MessageList.jsx: renders messages with MessageBubble and action buttons under assistant messages.
- src/components/MessageBubble.jsx: styles for assistant vs user, supports child action buttons area.
- src/components/InputBar.jsx: bottom pill input with send button.

Tech/Imports:

- import { Button } from "@/components/ui/button";
- import { Input } from "@/components/ui/input";
- import { ScrollArea } from "@/components/ui/scroll-area";
- import { Send, Search, Plus, Settings } from "lucide-react";

Visual notes (keep brief to save tokens):

- Fullscreen, dark background (bg-[${colors.bg || "#050509"}]).
- Right fixed-width sidebar ~${sidebar.width || 320}px with vertical divider.
- Chat area fills remaining space.
- Single assistant "Hello" bubble near upper-right initially.
- Bottom pill input bar with placeholder, circular send button.

Return format (IMPORTANT):
- Return ONLY ONE JSON object with exactly these keys as top-level properties:
  "src/App.jsx",
  "src/components/Layout.jsx",
  "src/components/Sidebar.jsx",
  "src/components/ChatHeader.jsx",
  "src/components/ChatArea.jsx",
  "src/components/MessageList.jsx",
  "src/components/MessageBubble.jsx",
  "src/components/InputBar.jsx"
- Do NOT wrap it in a code block.
- Do NOT add any explanation text before or after the JSON.
`.trim();

  const completion = await client.chat.completions.create({
model: CODE_MODEL,
temperature: 0.1,
max_tokens: 3200,
messages: [
{ role: "system", content: systemPrompt },
{ role: "user", content: userPrompt },
],
  });

  const msg = completion.choices?.[0]?.message;
  const raw = extractTextContent(msg);

  if (!raw || !raw.trim()) {
throw new Error("Code model returned empty content.");
  }

  const parsed = tryParseJsonMulti(raw);
  if (!parsed.ok) {
fs.writeFileSync(
path.join(WORKSPACE_ROOT, "codegen-multifile-raw.txt"),
raw,
"utf8"
);
console.error("❌ Failed to parse JSON from code generator.");
console.error("Last JSON error:", parsed.error?.message);
throw new Error(
"Invalid JSON from code generator (see codegen-multifile-raw.txt)."
);
  }

  const filesMap = parsed.value;

  const requiredFiles = [
"src/App.jsx",
"src/components/Layout.jsx",
"src/components/Sidebar.jsx",
"src/components/ChatHeader.jsx",
"src/components/ChatArea.jsx",
"src/components/MessageList.jsx",
"src/components/MessageBubble.jsx",
"src/components/InputBar.jsx",
  ];

  for (const f of requiredFiles) {
if (typeof filesMap[f] !== "string" || !filesMap[f].trim()) {
throw new Error(`Missing/empty content for required file: ${f}`);
}
  }

  return filesMap;
}

// -----------------------------------------------------------------------------
// SCREENSHOT + DIFF
// -----------------------------------------------------------------------------
async function takeScreenshot(iterationIndex) {
  console.log(
`📸 Taking screenshot of generated UI (iteration ${iterationIndex})...`
  );
  const relShotName = `${iterationIndex}-${GENERATED_SHOT}`;
  const result = await captureUI({
url: DEV_URL,
outPath: relShotName,
  });

  if (!result || !result.success) {
const msg = result?.error || "Unknown capture error";
throw new Error(`captureUI failed: ${msg}`);
  }

  const { fullPath } = resolveWorkspacePath(result.path);
  console.log(`✅ Saved screenshot: ${fullPath}`);
  return fullPath;
}

async function computeDiffImage(referencePath, generatedPath, diffOutPath) {
  console.log("🔍 Computing pixel diff image...");
  const { PNG } = await import("pngjs");
  const pixelmatch = (await import("pixelmatch")).default;

  const ref = PNG.sync.read(fs.readFileSync(referencePath));
  const gen = PNG.sync.read(fs.readFileSync(generatedPath));

  const { width, height } = ref;
  const diff = new PNG({ width, height });

  pixelmatch(ref.data, gen.data, diff.data, width, height, {
threshold: 0.1,
  });

  fs.writeFileSync(diffOutPath, PNG.sync.write(diff));
  console.log(`✅ Saved diff image: ${diffOutPath}`);
}

// -----------------------------------------------------------------------------
// MAIN PIPELINE (Lite)
// -----------------------------------------------------------------------------
async function bootstrapFromImageTwoStep() {
  const imagePath = path.join(WORKSPACE_ROOT, PRIMARY_REFERENCE_IMAGE);

  if (!fs.existsSync(imagePath)) {
console.log(
`⚠️ No reference image found at ${imagePath}. Using fallback.`
);
return;
  }

  console.log(
`🎬 Bootstrap from reference image: ${PRIMARY_REFERENCE_IMAGE}`
  );
  console.log(`👁️ Layout model: ${VISION_MODEL}`);
  console.log(`🧠 Code model: ${CODE_MODEL}`);
  console.log(`🔁 Refinement iterations: ${REFINEMENT_ITERATIONS}`);

  try {
// 1) Layout analysis (vision)
console.log("📸 Step 1: analyzing screenshot into layoutSpec...");
let layoutSpec = await analyzeScreenshotAdvanced(imagePath, {
model: VISION_MODEL,
temperature: 0.0,
max_tokens: 1400,
debugOutDir: path.join(WORKSPACE_ROOT, "layout-debug"),
});

layoutSpec = layoutSpec || {};
layoutSpec.canvas = layoutSpec.canvas || {};
layoutSpec.layout = layoutSpec.layout || {};
layoutSpec.sidebar = layoutSpec.sidebar || {};
layoutSpec.main = layoutSpec.main || {};
layoutSpec.message_list = layoutSpec.message_list || {};
layoutSpec.message_bubble = layoutSpec.message_bubble || {};
layoutSpec.input_bar = layoutSpec.input_bar || {};
layoutSpec.colors = layoutSpec.colors || {};
layoutSpec.typography = layoutSpec.typography || {};

// 🔐 رنگ‌ها و مقادیر پیش‌فرض امن (جلوگیری از NaN)
layoutSpec.colors.bg =
layoutSpec.colors.bg ||
layoutSpec.canvas.background_color ||
"#050509";
layoutSpec.colors.border = layoutSpec.colors.border || "#272727";
layoutSpec.colors.text = layoutSpec.colors.text || "#f5f5f5";
layoutSpec.colors.text_muted =
layoutSpec.colors.text_muted || "#9ca3af";
layoutSpec.colors.accent =
layoutSpec.colors.accent || layoutSpec.input_bar.accent_color || "#fb7185";

layoutSpec.sidebar.width = Number(layoutSpec.sidebar.width) || 320;
layoutSpec.sidebar.padding_x =
typeof layoutSpec.sidebar.padding_x === "number"
? layoutSpec.sidebar.padding_x
: 16;
layoutSpec.sidebar.padding_y =
typeof layoutSpec.sidebar.padding_y === "number"
? layoutSpec.sidebar.padding_y
: 16;
layoutSpec.sidebar.border_right_color =
layoutSpec.sidebar.border_right_color ||
layoutSpec.colors.border ||
"#272727";

layoutSpec.main.padding_x = Math.max(
Number(layoutSpec.main.padding_x) || 0,
32
);
layoutSpec.main.padding_y = Math.max(
Number(layoutSpec.main.padding_y) || 0,
24
);

layoutSpec.message_list.max_width_ratio =
Number(layoutSpec.message_list.max_width_ratio) || 0.55;
layoutSpec.message_list.row_gap =
Number(layoutSpec.message_list.row_gap) || 16;

layoutSpec.message_bubble.assistant_bg =
layoutSpec.message_bubble.assistant_bg || "#262626";
layoutSpec.message_bubble.border_radius =
Number(layoutSpec.message_bubble.border_radius) || 18;

layoutSpec.input_bar.height =
Number(layoutSpec.input_bar.height) || 56;
layoutSpec.input_bar.background_color =
layoutSpec.input_bar.background_color || "#020617";
layoutSpec.input_bar.field_radius =
Number(layoutSpec.input_bar.field_radius) || 999;
layoutSpec.input_bar.button_radius =
Number(layoutSpec.input_bar.button_radius) || 999;
layoutSpec.input_bar.padding_x =
typeof layoutSpec.input_bar.padding_x === "number"
? layoutSpec.input_bar.padding_x
: 20;
layoutSpec.input_bar.padding_y =
typeof layoutSpec.input_bar.padding_y === "number"
? layoutSpec.input_bar.padding_y
: 12;
layoutSpec.input_bar.border_top_color =
layoutSpec.input_bar.border_top_color ||
layoutSpec.colors.bg ||
"#050509";
layoutSpec.input_bar.accent_color =
layoutSpec.input_bar.accent_color ||
layoutSpec.colors.accent ||
"#fb7185";

layoutSpec.typography.body_size =
Number(layoutSpec.typography.body_size) || 14;
layoutSpec.typography.body_weight =
Number(layoutSpec.typography.body_weight) || 400;

fs.writeFileSync(
path.join(WORKSPACE_ROOT, "layout-analysis.json"),
JSON.stringify(layoutSpec, null, 2),
"utf8"
);
console.log("✅ Saved layout-analysis.json");

// 2) Initial codegen
console.log("🧱 Step 2: generating initial React/Tailwind code...");
const initialFilesMap = await generateCodeFromLayoutSpec(layoutSpec);

for (const [relPath, content] of Object.entries(initialFilesMap)) {
const normalized = path.join(APP_NAME, relPath).replace(/\\/g, "/");
console.log(`📝 Writing file: ${normalized}`);
safeWrite(normalized, content);
}

console.log("✅ Initial generation complete.");

// 3) Refinement loop (visual + behavior در یک مرحله patch)
if (REFINEMENT_ITERATIONS <= 0) {
console.log("🔁 Refinement disabled (REFINEMENT_ITERATIONS=0).");
return;
}

console.log(
`🔁 Starting refinement loop (max ${REFINEMENT_ITERATIONS} iterations)...`
);
const serverProc = startServer();
// کمی صبر برای بالا آمدن Vite
await new Promise((r) => setTimeout(r, 8000));

let currentFilesMap = initialFilesMap;

for (let iteration = 1; iteration <= REFINEMENT_ITERATIONS; iteration++) {
console.log(
`\n🌀 Refinement iteration ${iteration}/${REFINEMENT_ITERATIONS}`
);

const shotPath = await takeScreenshot(iteration);
const diffOutPath = path.join(
WORKSPACE_ROOT,
`${iteration}-${DIFF_IMAGE}`
);

await computeDiffImage(imagePath, shotPath, diffOutPath);

console.log("🧠 Asking vision model for visual diff analysis...");
const diffAnalysis = await analyzeUIWithDiff({
referenceImagePath: imagePath,
generatedImagePath: shotPath,
diffImagePath: diffOutPath,
model: VISION_MODEL,
max_tokens: 900,
});

const patchSystemPrompt = `
You are a senior UI implementation engineer specializing in pixel-accurate React + Tailwind reproduction from reference screenshots.

Your task is to refine an EXISTING multi-file React + Tailwind chatbot UI so that it matches the reference screenshot as closely as possible while preserving working structure and behavior.

You will be given:
- Current multi-file React code as JSON.
- A visual diff analysis (textual) derived from comparing the current render to the reference screenshot.

Your priorities, in order:
1) Maximize visual fidelity to the reference screenshot.
2) Preserve the existing component/file structure and exports.
3) Keep interactions working or add them if missing.
4) Make the smallest targeted edits necessary to improve the match.

You must treat visual fidelity as the top priority.
That means you should carefully correct:
- overall page background tone/gradient/contrast
- panel/background colors
- border colors and border visibility
- corner radii
- shadows and depth
- spacing, padding, gaps, and margins
- horizontal and vertical alignment
- width proportions between sidebar, chat area, and inner content
- message bubble widths, heights, alignment, and internal spacing
- input bar size, radius, icon placement, and button sizing
- icon containers, avatar sizing, circular shapes, and alignment
- typography scale, weight, and color hierarchy
- header height, separators, and toolbar spacing

Do NOT make broad redesigns.
Do NOT invent new sections, new visual motifs, or new interactions.
Do NOT replace the layout with a different chatbot design pattern.
Do NOT add new files or dependencies.
Do NOT break exports, props, or component names.

When adjusting the UI:
- Prefer targeted Tailwind class changes over rewriting logic.
- Keep DOM structure stable unless a small structural tweak is required for a more accurate match.
- If the diff analysis mentions a mismatch, aggressively correct that mismatch in code.
- Prefer exact-looking spacing/radius/color choices over generic defaults.
- Avoid arbitrary vivid colors unless they are clearly required by the reference.
- Make the UI look polished and intentional, not approximate.

Required behaviors to preserve or implement if missing:
1) Sidebar collapse/expand via a button.
2) Settings modal open/close with overlay click dismissal support.
3) Message action buttons under assistant messages with stub handlers.
4) Input bar enter-to-send and click-to-send, then clear input.

Return ONLY a single JSON object.
The JSON object must contain EXACTLY these keys and no others:
  "src/App.jsx",
  "src/components/Layout.jsx",
  "src/components/Sidebar.jsx",
  "src/components/ChatHeader.jsx",
  "src/components/ChatArea.jsx",
  "src/components/MessageList.jsx",
  "src/components/MessageBubble.jsx",
  "src/components/InputBar.jsx"

Each value must be a complete file as a string.
Return no markdown, no code fences, no explanation, no commentary.
`.trim();


const patchUserPrompt = `
VISUAL_DIFF_ANALYSIS:
${JSON.stringify(diffAnalysis, null, 2)}

CURRENT_CODE:
${JSON.stringify(currentFilesMap, null, 2)}

Refinement objective:
Make the rendered UI match the reference screenshot with much higher pixel fidelity.

Refinement rules:
- Focus first on the largest visible mismatches.
- Correct all obvious differences in:
  - background color/gradient
  - panel colors
  - border opacity and separator visibility
  - rounded corners
  - shadow softness/strength
  - spacing, padding, gaps, margins
  - sidebar width and collapsed width
  - chat content width and max-width
  - header height and internal alignment
  - message bubble size, alignment, radius, and spacing
  - avatar size and placement
  - input bar height, background, radius, and send button placement
  - icon size, padding, and alignment
  - typography scale, weight, and muted vs primary text color

Implementation constraints:
- Preserve existing file names, exports, and general component responsibilities.
- Do not add dependencies.
- Do not add extra files.
- Do not rewrite everything if smaller changes can achieve a closer visual match.
- If behavior already exists, preserve it while improving styling.
- If behavior is missing, implement it with minimal code.

Behavior requirements:
- Sidebar collapse button must work and layout must respond correctly.
- Settings modal must open and close correctly, including overlay click dismissal.
- Assistant messages must show action buttons underneath with stub handlers.
- InputBar must send on Enter and click and then clear the input.

Important:
- Prefer precise Tailwind utility values that visually match the reference better.
- Prefer tighter, intentional spacing over loose generic spacing.
- Prefer muted, reference-like color choices over default Tailwind blues unless the screenshot clearly uses them.
- Keep the design consistent across all components.
- Make the result feel like one coherent UI, not a mix of unrelated styles.

Output requirements:
- Return ONLY the new multi-file JSON.
- Use the EXACT same keys as CURRENT_CODE.
- No markdown, no code fences, no explanations, no prose before or after the JSON.
`.trim();


const patchCompletion = await client.chat.completions.create({
model: CODE_MODEL,
temperature: 0.1,
max_tokens: 2600,
messages: [
{ role: "system", content: patchSystemPrompt },
{ role: "user", content: patchUserPrompt },
],
});

const patchMsg = patchCompletion.choices?.[0]?.message;
const patchRaw = extractTextContent(patchMsg);
if (!patchRaw || !patchRaw.trim()) {
console.warn("⚠️ Patch model returned empty content, stopping loop.");
break;
}

const patchParsed = tryParseJsonMulti(patchRaw);
if (!patchParsed.ok) {
fs.writeFileSync(
path.join(
WORKSPACE_ROOT,
`codegen-patch-raw-${iteration}.txt`
),
patchRaw,
"utf8"
);
console.warn(
`⚠️ Invalid JSON from patch generator at iteration ${iteration}. Stopping loop.`
);
console.warn("Last JSON error:", patchParsed.error?.message);
break;
}

const patchedFilesMap = patchParsed.value;

const requiredFiles = [
"src/App.jsx",
"src/components/Layout.jsx",
"src/components/Sidebar.jsx",
"src/components/ChatHeader.jsx",
"src/components/ChatArea.jsx",
"src/components/MessageList.jsx",
"src/components/MessageBubble.jsx",
"src/components/InputBar.jsx",
];
let missing = false;
for (const f of requiredFiles) {
if (
typeof patchedFilesMap[f] !== "string" ||
!patchedFilesMap[f].trim()
) {
console.warn(
`⚠️ Missing/empty content for required file in patch: ${f}. Stopping loop.`
);
missing = true;
break;
}
}
if (missing) break;

for (const [relPath, content] of Object.entries(patchedFilesMap)) {
const normalized = path.join(APP_NAME, relPath).replace(/\\/g, "/");
console.log(
`📝 [iteration ${iteration}] Writing patched file: ${normalized}`
);
safeWrite(normalized, content);
}

currentFilesMap = patchedFilesMap;
console.log(`✅ Iteration ${iteration} refinement applied.`);

await new Promise((r) => setTimeout(r, 2500));
}

console.log("🔁 Refinement loop finished.");

console.log("⏹ Stopping dev server...");
try {
serverProc.kill("SIGINT");
} catch {
console.warn("⚠️ Failed to kill dev server process cleanly.");
}
  } catch (err) {
console.error("❌ Pipeline failed:", err);
console.log("🛟 Writing fallback layout files...");
safeWrite("chatbot-app/src/App.jsx", fallbackAppJsx);
safeWrite("chatbot-app/src/components/Layout.jsx", fallbackLayoutJsx);
  }
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------
async function run() {
  try {
await ensureProjectExists();
await bootstrapFromImageTwoStep();

console.log("✅ Bootstrap finished.");
console.log(
"👉 You can now run: cd chatbot-app && npm run dev -- --port 5173"
);
console.log(`   Then open ${DEV_URL} in your browser.`);
  } catch (err) {
console.error("❌ Agent crashed:", err);
  }
}

run();
