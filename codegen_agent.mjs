import fs from "fs";
import path from "path";
import OpenAI from "openai";

import { buildSmartContext } from "./tools/context_engine.js";
import { listBackendFiles } from "./tools/list_backend_files.js";
import { readProjectFile } from "./tools/readProjectFile.js";
import { CODEGEN_MODEL } from "../ai-sandbox/backend1/config/openai.mjs";
/* -------------------------------------------------- */
/* ---------------- CONFIGURATION ------------------- */
/* -------------------------------------------------- */

const PROJECT_ROOT = process.cwd();

const USER_SESSION_ID =
  typeof process.env.USER_SESSION_ID === "string" &&
  process.env.USER_SESSION_ID.trim()
    ? process.env.USER_SESSION_ID.trim()
    : null;

const USER_REQUEST_ID =
  typeof process.env.USER_REQUEST_ID === "string" &&
  process.env.USER_REQUEST_ID.trim()
    ? process.env.USER_REQUEST_ID.trim()
    : null;

const HISTORY_ROOT = path.resolve(PROJECT_ROOT, ".agent-history");

const DEFAULT_CONFIG = {
  planPath: "./planner_plan.json",
  workspace: "./",
  taskWorkspace: "./",
  model: CODEGEN_MODEL,
  temperature: 0.1,
  apiKey: process.env.OPENAI_API_KEY || "***REMOVED-SECRET***",
  baseURL: process.env.OPENAI_BASE_URL || "https://api.gapgpt.app/v1",
  skipExisting: true,
  maxContextFiles: 10,
  perFileMaxContextFiles: 8,
  dependencyDepth: 2,
  perFileDependencyDepth: 2,
  sessionId: USER_SESSION_ID,
  requestId: USER_REQUEST_ID,
};

const DESIGN_REFERENCE_FILENAMES = [
  "page.tsx",
  "layout.tsx",
  "globals.css",
  "page.jsx",
  "layout.jsx",
  "globals.jsx",
  "globals.scss",
  "globals.sass",
  "globals.less",
];

/* -------------------------------------------------- */
/* ---------------- SYSTEM PROMPTS ------------------ */
/* -------------------------------------------------- */

const SYSTEM_PROMPTS = {
  backend: `
تو یک Senior Backend Engineer هستی.

Stack:
- Node.js (ESM)
- TypeScript (NodeNext)
- Fastify
- Drizzle ORM
- SQLite (better-sqlite3)
- Vitest
- bcrypt (نه bcryptjs)

قوانین حیاتی:
- هرگز از bcryptjs استفاده نکن.
- هرگز از tap استفاده نکن.
- فقط از فایل‌هایی که در Project Structure آمده استفاده کن.
- اگر فایل وجود ندارد، آن را import نکن.
- drizzle eq باید از "drizzle-orm" import شود.
- پروژه ESM است (import/export استاندارد).
- اگر فایل هدف قبلاً وجود دارد، آن را با context موجود به‌روز کن، نه اینکه رفتار قبلی را از بین ببری.
- خروجی فقط سورس کد خالص فایل باشد.
`.trim(),

  frontend: `
تو یک Senior Frontend Engineer هستی.

Stack:
- React 18+ (TypeScript)
- Next.js (App Router)
- TailwindCSS
- Lucide React (icons)
- CSS Modules

قوانین حیاتی:
- فقط از فایل‌هایی که در Project Structure آمده استفاده کن.
- اگر فایل وجود ندارد، آن را import نکن.
- همیشه TypeScript type-safe باشد.
- از React hooks به درستی استفاده کن.
- اگر فایل هدف قبلاً وجود دارد، آن را با context موجود به‌روز کن.
- خروجی فقط سورس کد خالص فایل باشد.
`.trim(),

  fullstack: `
تو یک Senior Full-Stack Engineer هستی.

Backend Stack:
- Node.js (ESM), TypeScript, Fastify, Drizzle ORM, SQLite

Frontend Stack:
- React 18+, TypeScript, Next.js, TailwindCSS, Lucide React

قوانین حیاتی:
- فقط از فایل‌هایی که در Project Structure آمده استفاده کن.
- اگر فایل وجود ندارد، آن را import نکن.
- کد باید type-safe و production-ready باشد.
- اگر فایل هدف قبلاً وجود دارد، آن را با context موجود به‌روز کن.
- خروجی فقط سورس کد خالص فایل باشد.
`.trim(),
};

/* -------------------------------------------------- */
/* ----------- UNIFIED PLAN FILE EXTRACTOR ---------- */
/* -------------------------------------------------- */

function extractFilesFromPlan(plan) {
  const files = [];

  if (Array.isArray(plan.files_to_create) || Array.isArray(plan.files_to_modify)) {
    for (const entry of plan.files_to_create || []) {
      if (!entry?.path) continue;
      files.push({
        path: entry.path,
        content: entry.content || null,
        description: entry.purpose || "",
        action: "create",
      });
    }

    for (const entry of plan.files_to_modify || []) {
      if (!entry?.path) continue;
      files.push({
        path: entry.path,
        content: entry.content || null,
        description: entry.purpose || "",
        action: "modify",
      });
    }

    return files;
  }

  if (Array.isArray(plan.files)) {
    for (const entry of plan.files) {
      if (!entry?.path) continue;
      files.push({
        path: entry.path,
        content: entry.content || null,
        description: entry.purpose || entry.description || "",
        action: "generate",
      });
    }
    return files;
  }

  if (Array.isArray(plan.phases)) {
    for (const phase of plan.phases) {
      if (!Array.isArray(phase.steps)) continue;
      for (const step of phase.steps) {
        if (!Array.isArray(step.files)) continue;
        for (const f of step.files) {
          if (typeof f === "string") {
            files.push({
              path: f,
              content: null,
              description: step.description || "",
              action: "generate",
            });
          } else if (f?.path) {
            files.push({
              path: f.path,
              content: f.content || null,
              description: f.purpose || step.description || "",
              action: "generate",
            });
          }
        }
      }
    }
    return files;
  }

  return files;
}

/* -------------------------------------------------- */
/* ---------------- HELPER FUNCTIONS ---------------- */
/* -------------------------------------------------- */

function normalizeRelativePath(p) {
  if (!p || typeof p !== "string") return "";
  let norm = p.trim();
  if (norm.startsWith("./")) norm = norm.slice(2);
  norm = path.normalize(norm);
  return norm.replace(/\\/g, "/");
}

function normalizeWorkspaceRoot(workspace) {
  const rel = normalizeRelativePath(workspace);
  if (!rel || rel === ".") return "";
  return rel;
}

function resolveFilePath(workspaceRoot, relativePath) {
  const workspace = normalizeWorkspaceRoot(workspaceRoot);
  const rel = normalizeRelativePath(relativePath);

  if (!rel) return path.resolve(PROJECT_ROOT, workspace);

  if (workspace && (rel === workspace || rel.startsWith(`${workspace}/`))) {
    return path.resolve(PROJECT_ROOT, rel);
  }

  return path.resolve(PROJECT_ROOT, workspace, rel);
}

function fileNeedsGeneration(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      console.log(`   ⏭️  Skipping directory: ${filePath}`);
      return false;
    }

    const content = fs.readFileSync(filePath, "utf8").trim();

    if (
      !content ||
      content.includes("TODO") ||
      content.includes("/* placeholder */") ||
      content.length < 50
    ) {
      return true;
    }

    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    console.error(`   ⚠️  Error checking file ${filePath}:`, error.message);
    return false;
  }
}

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function cleanGeneratedCode(content) {
  let cleaned = String(content || "").trim();

  if (cleaned.startsWith("```")) {
cleaned = cleaned
.replace(/^```[a-zA-Z0-9_-]*\n?/, "")
      .replace(/```$/, "")
.trim();
  }

  return cleaned;
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function basenameScore(candidateName, targetName) {
  const candidate = candidateName.toLowerCase();
  const target = targetName.toLowerCase();

  if (candidate === target) return 100;
  if (candidate.endsWith(target)) return 85;
  if (candidate.includes(target)) return 65;
  return 0;
}

function collectFilenameHints(text) {
  const msg = String(text || "");

  const pathRegex =
/(?:\/?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.(?:tsx?|jsx?|css|scss|md|json|ya?ml|html|xml|mjs|cjs|ts|js))/g;

  const filenameRegex =
/\b[A-Za-z0-9._-]+\.(?:tsx?|jsx?|css|scss|md|json|ya?ml|html|xml|mjs|cjs|ts|js)\b/g;

  const matches = uniq([
...(msg.match(pathRegex) || []),
...(msg.match(filenameRegex) || []),
  ]);

  return matches.map(normalizeRelativePath);
}

async function findFilesByName(filename, { dir = "", limit = 10 } = {}) {
  const target = normalizeRelativePath(filename);
  if (!target) return [];

  const baseName = path.basename(target).toLowerCase();
  const searchDir = normalizeWorkspaceRoot(dir);

  const res = await listBackendFiles({
dir: searchDir,
maxDepth: 12,
includeFiles: true,
includeDirs: false,
includeMeta: true,
  });

  if (!res?.success || !Array.isArray(res.files)) return [];

  const scored = res.files
.filter((item) => !item.is_dir)
.map((item) => {
const filePath = normalizeRelativePath(item.path);
const name = path.basename(filePath).toLowerCase();
const score = basenameScore(name, baseName);
const depthPenalty = filePath.split("/").length;
const areaBonus =
filePath.includes("frontend/") ||
filePath.includes("app/") ||
filePath.includes("src/")
? 5
: 0;

return {
path: filePath,
score: score + areaBonus - Math.min(depthPenalty, 8),
};
})
.filter((x) => x.score > 0)
.sort((a, b) => b.score - a.score)
.slice(0, limit);

  return uniq(scored.map((x) => x.path));
}

async function resolveExistingPathByName(workspaceRoot, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return null;

  const direct = resolveFilePath(workspaceRoot, normalized);
  if (fs.existsSync(direct)) {
return direct;
  }

  const baseName = path.basename(normalized);
  const matches = await findFilesByName(baseName, {
dir: workspaceRoot,
limit: 10,
  });

  if (matches.length > 0) {
return path.resolve(PROJECT_ROOT, matches[0]);
  }

  return null;
}

async function readFileAsContext(relativePath, maxBytes = 200000) {
  try {
const res = await readProjectFile({
path: relativePath,
maxBytes,
});

if (!res?.success) return null;
return String(res.content || "");
  } catch {
return null;
  }
}

async function readExistingFileContent(workspaceRoot, relativeFile) {
  const fullPath = await resolveExistingPathByName(workspaceRoot, relativeFile);
  if (!fullPath) return "";

  try {
const rel = path.relative(PROJECT_ROOT, fullPath).replace(/\\/g, "/");
const content = await readFileAsContext(rel, 200000);
return content || "";
  } catch {
return "";
  }
}

async function collectReferenceSnippets(workspaceRoot, planText = "") {
  const seen = new Set();
  const snippets = [];

  const hints = uniq([
...DESIGN_REFERENCE_FILENAMES,
...collectFilenameHints(planText),
  ]);

  for (const name of hints) {
const matches = await findFilesByName(name, {
dir: workspaceRoot,
limit: 3,
});

for (const relPath of matches) {
if (seen.has(relPath)) continue;
seen.add(relPath);

const content = await readFileAsContext(relPath, 140000);
if (!content) continue;

snippets.push({
path: relPath,
content: content.slice(0, 3500),
});

if (snippets.length >= 8) return snippets;
}
  }

  return snippets;
}

async function readWorkspaceContext(workspaceRoot, planText = "") {
  const rootRel = normalizeWorkspaceRoot(workspaceRoot);
  let context = "";

  const configs = [
"package.json",
"tsconfig.json",
"vite.config.ts",
"next.config.ts",
"next.config.js",
"tailwind.config.ts",
"tailwind.config.js",
"biome.json",
  ];

  for (const cfg of configs) {
const cfgPath = resolveFilePath(rootRel, cfg);
if (fs.existsSync(cfgPath)) {
context += `\n--- ${cfg} ---\n`;
context += fs.readFileSync(cfgPath, "utf8");
}
  }

  const treeRes = await listBackendFiles({
dir: rootRel,
maxDepth: 5,
includeFiles: true,
includeDirs: true,
includeMeta: true,
  });

  context += "\n--- Project Structure ---\n";
  if (treeRes?.success && Array.isArray(treeRes.files)) {
for (const item of treeRes.files) {
const meta = [];
if (typeof item.size === "number") meta.push(`size=${item.size}`);
if (typeof item.ext === "string" && item.ext) meta.push(`ext=${item.ext}`);
context += `${item.is_dir ? "DIR " : "FILE"}: ${item.path}${
meta.length ? ` (${meta.join(", ")})` : ""
}\n`;
}
  } else {
context += "<tree unavailable>\n";
  }

  const referenceSnippets = await collectReferenceSnippets(rootRel, planText);
  if (referenceSnippets.length > 0) {
context += "\n--- Reference Files ---\n";
for (const ref of referenceSnippets) {
context += `FILE: ${ref.path}\n`;
context += `${ref.content.slice(0, 5000)}\n`;
context += `---\n`;
}
  }

  return context;
}

function buildPrompt({
  relativeFile,
  action,
  stepDescription,
  plannerDraft,
  currentContent,
  workspaceContext,
  globalSmartContext,
  fileSmartContext,
  plan,
  projectType,
}) {
  const planMeta = {
name: plan.name,
goal: plan.goal,
summary: plan.summary,
task_scope: plan.task_scope,
dependencies: plan.dependencies || [],
constraints: plan.constraints || [],
acceptance_criteria: plan.acceptance_criteria || [],
notes: plan.notes || "",
  };

  return `
Target file:
${relativeFile}

Action:
${action}

Task description:
${stepDescription || ""}

Planner draft (optional, may be partial):
${plannerDraft || "<none>"}

Current file content (if the file already exists):
${currentContent || "<none>"}

Plan metadata:
${JSON.stringify(planMeta, null, 2)}

Workspace context:
${workspaceContext}

Global semantic context:
${JSON.stringify(globalSmartContext, null, 2)}

File-specific semantic context:
${JSON.stringify(fileSmartContext, null, 2)}

Project type:
${projectType}

Strict requirements:
- Use only existing project structure and valid imports.
- Do not invent paths or modules that do not exist.
- If modifying a file, preserve the intended behavior and update it cleanly.
- Make the file production-ready and complete.
- Output ONLY the source code for the target file.
`.trim();
}

async function generateCode(
  client,
  config,
  entry,
  plan,
  workspaceRoot,
  workspaceContext,
  globalSmartContext,
  projectType,
  currentContent
) {
  const systemPrompt = SYSTEM_PROMPTS[projectType] || SYSTEM_PROMPTS.fullstack;

  const fileQuery = [
entry.path,
entry.description,
plan.goal,
plan.summary,
plan.name,
plan.task_scope,
  ]
.filter(Boolean)
.join(" ");

  const fileSmartContext = await buildSmartContext({
userMessage: fileQuery,
maxFiles: config.perFileMaxContextFiles,
dependencyDepth: config.perFileDependencyDepth,
  });

  const prompt = buildPrompt({
relativeFile: entry.path,
action: entry.action || "generate",
stepDescription: entry.description || plan.goal || "",
plannerDraft: entry.content || "",
currentContent,
workspaceContext,
globalSmartContext,
fileSmartContext,
plan,
projectType,
  });

  const response = await client.chat.completions.create({
model: config.model,
temperature: config.temperature,
messages: [
{ role: "system", content: systemPrompt },
{ role: "user", content: prompt },
],
  });

  const raw = response.choices?.[0]?.message?.content || "";
  return cleanGeneratedCode(raw);
}

function findBestOutputPath(workspaceRoot, relativeFile) {
  const normalized = normalizeRelativePath(relativeFile);
  return resolveFilePath(workspaceRoot, normalized);
}

/* -------------------------------------------------- */
/* --------- HISTORY / CHECKPOINT HELPERS ----------- */
/* -------------------------------------------------- */

function getHistoryBaseDir() {
  return HISTORY_ROOT;
}

function requireHistoryIds(sessionId, requestId) {
  const sid =
typeof sessionId === "string" && sessionId.trim()
? sessionId.trim()
: null;

  const rid =
typeof requestId === "string" && requestId.trim()
? requestId.trim()
: null;

  if (!sid || !rid) {
return null;
  }

  return { sessionId: sid, requestId: rid };
}

function getRequestHistoryDir(sessionId, requestId) {
  const ids = requireHistoryIds(sessionId, requestId);
  if (!ids) {
throw new Error("sessionId and requestId are required for history storage");
  }

  return path.join(getHistoryBaseDir(), ids.sessionId, ids.requestId);
}

function loadRequestMeta(sessionId, requestId) {
  const dir = getRequestHistoryDir(sessionId, requestId);
  const metaPath = path.join(dir, "meta.json");

  if (!fs.existsSync(metaPath)) {
return {
sessionId,
requestId,
createdAt: new Date().toISOString(),
files: [],
};
  }

  try {
const raw = fs.readFileSync(metaPath, "utf8");
const parsed = JSON.parse(raw);

return {
sessionId,
requestId,
createdAt: parsed.createdAt || new Date().toISOString(),
files: Array.isArray(parsed.files) ? parsed.files : [],
};
  } catch {
return {
sessionId,
requestId,
createdAt: new Date().toISOString(),
files: [],
};
  }
}

function saveRequestMeta(sessionId, requestId, meta) {
  const dir = getRequestHistoryDir(sessionId, requestId);
  if (!fs.existsSync(dir)) {
fs.mkdirSync(dir, { recursive: true });
  }

  const safeMeta = {
sessionId,
requestId,
createdAt: meta.createdAt || new Date().toISOString(),
files: Array.isArray(meta.files) ? meta.files : [],
  };

  const metaPath = path.join(dir, "meta.json");
  fs.writeFileSync(metaPath, JSON.stringify(safeMeta, null, 2), "utf8");
}

function recordFileCheckpoint({
  fullPath,
  relativePath,
  sessionId,
  requestId,
}) {
  try {
const ids = requireHistoryIds(
sessionId || USER_SESSION_ID,
requestId || USER_REQUEST_ID
);

if (!ids) {
console.warn(
`⚠️  Skipping checkpoint for ${relativePath}: missing sessionId/requestId`
);
return;
}

const relNorm = normalizeRelativePath(
relativePath ||
path.relative(PROJECT_ROOT, fullPath).replace(/\\/g, "/")
);

const historyDir = getRequestHistoryDir(ids.sessionId, ids.requestId);
const filesDir = path.join(historyDir, "files");

if (!fs.existsSync(filesDir)) {
fs.mkdirSync(filesDir, { recursive: true });
}

const meta = loadRequestMeta(ids.sessionId, ids.requestId);
const existedBefore = fs.existsSync(fullPath);
let snapshotPath = null;

if (existedBefore) {
const snapshotFullPath = path.join(filesDir, `${relNorm}.before`);
const snapshotDir = path.dirname(snapshotFullPath);

if (!fs.existsSync(snapshotDir)) {
fs.mkdirSync(snapshotDir, { recursive: true });
}

const currentContent = fs.readFileSync(fullPath, "utf8");
fs.writeFileSync(snapshotFullPath, currentContent, "utf8");
snapshotPath = path
.relative(PROJECT_ROOT, snapshotFullPath)
.replace(/\\/g, "/");

console.log(
`   💾 Checkpoint saved for ${relNorm} -> ${snapshotPath} (session=${ids.sessionId}, request=${ids.requestId})`
);
} else {
console.log(
`   💾 Marking new file for undo: ${relNorm} (session=${ids.sessionId}, request=${ids.requestId})`
);
}

const already = meta.files.find((f) => f.relativePath === relNorm);
if (!already) {
meta.files.push({
relativePath: relNorm,
fullPath,
existedBefore,
snapshotPath,
});
saveRequestMeta(ids.sessionId, ids.requestId, meta);
}
  } catch (err) {
console.warn("⚠️  Failed to record file checkpoint:", err.message);
  }
}

/* -------------------------------------------------- */
/* ---------------- MAIN FUNCTION ------------------- */
/* -------------------------------------------------- */

export async function runCodegen(options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };

  const effectiveSessionId =
(typeof config.sessionId === "string" && config.sessionId.trim()
? config.sessionId.trim()
: USER_SESSION_ID) || null;

  const effectiveRequestId =
(typeof config.requestId === "string" && config.requestId.trim()
? config.requestId.trim()
: USER_REQUEST_ID) || null;

  console.log("⚙️ Starting code generation...\n");
  console.log(`📁 Workspace: ${config.workspace}`);
  console.log(`📋 Plan: ${config.planPath}`);
  console.log(`🎯 Project Type: ${config.projectType || "fullstack"}`);
  console.log(`🧾 Session ID: ${effectiveSessionId || "<missing>"}`);
  console.log(`🔁 Request ID: ${effectiveRequestId || "<missing>"}\n`);

  const client = new OpenAI({
apiKey: config.apiKey,
baseURL: config.baseURL,
  });

  if (!fs.existsSync(config.planPath)) {
throw new Error(`Plan file not found: ${config.planPath}`);
  }

  const plan = JSON.parse(fs.readFileSync(config.planPath, "utf8"));

  const isTaskMode =
plan.task_type === "task" ||
Array.isArray(plan.files_to_create) ||
Array.isArray(plan.files_to_modify);

  console.log(`📊 Plan mode: ${isTaskMode ? "task-level" : "project-level"}`);

  const workspaceRoot = isTaskMode
? normalizeWorkspaceRoot(config.taskWorkspace || "./")
: normalizeWorkspaceRoot(config.workspace);

  console.log(`📁 Effective workspace: ${workspaceRoot || "."}\n`);

  const planText = [
plan.name,
plan.goal,
plan.summary,
plan.task_scope,
plan.notes,
JSON.stringify(plan.context_assumptions || []),
JSON.stringify(plan.files_to_create || []),
JSON.stringify(plan.files_to_modify || []),
  ]
.filter(Boolean)
.join(" ");

  const workspaceContext = await readWorkspaceContext(workspaceRoot, planText);

  const globalSmartContext = await buildSmartContext({
userMessage: planText,
maxFiles: config.maxContextFiles,
dependencyDepth: config.dependencyDepth,
  });

  const results = {
success: true,
filesGenerated: [],
filesSkipped: [],
errors: [],
stats: {
totalFiles: 0,
generated: 0,
skipped: 0,
failed: 0,
},
  };

  const fileEntries = extractFilesFromPlan(plan);

  if (fileEntries.length === 0) {
console.warn("⚠️  No files found in plan. Check plan structure.");
return results;
  }

  console.log(`📝 Files to process: ${fileEntries.length}\n`);

  for (let i = 0; i < fileEntries.length; i++) {
const entry = fileEntries[i];
results.stats.totalFiles++;

const relativeFile = normalizeRelativePath(entry.path);
const fullPath = findBestOutputPath(workspaceRoot, relativeFile);
const progress = `[${i + 1}/${fileEntries.length}]`;

const currentContent = await readExistingFileContent(
workspaceRoot,
relativeFile
);

const isModifyAction = entry.action === "modify";
const shouldSkip =
config.skipExisting && !isModifyAction && !fileNeedsGeneration(fullPath);

if (shouldSkip) {
console.log(
`   ⏭️  ${progress} Skipping (already implemented): ${relativeFile}`
);
results.filesSkipped.push(relativeFile);
results.stats.skipped++;

if (config.onProgress) {
config.onProgress({ type: "file_skipped", file: relativeFile });
}
continue;
}

console.log(`   🤖 ${progress} Generating: ${relativeFile}`);

if (config.onProgress) {
config.onProgress({ type: "file_generating", file: relativeFile });
}

try {
const projectType =
config.projectType || plan.task_scope || plan.project_type || "fullstack";

const code = await generateCode(
client,
config,
entry,
plan,
workspaceRoot,
workspaceContext,
globalSmartContext,
projectType,
currentContent
);

if (!code.trim()) {
throw new Error("Empty output from AI");
}

recordFileCheckpoint({
fullPath,
relativePath: relativeFile,
sessionId: effectiveSessionId,
requestId: effectiveRequestId,
});

ensureDirForFile(fullPath);
fs.writeFileSync(fullPath, code, "utf8");

console.log(`   ✅ ${progress} Written: ${relativeFile}`);
results.filesGenerated.push(relativeFile);
results.stats.generated++;

if (config.onProgress) {
config.onProgress({ type: "file_generated", file: relativeFile });
}
} catch (err) {
console.error(`   ❌ ${progress} Error on ${relativeFile}:`, err.message);
results.errors.push({ file: relativeFile, error: err.message });
results.stats.failed++;

if (config.onProgress) {
config.onProgress({
type: "file_error",
file: relativeFile,
error: err.message,
});
}
}
  }

  console.log("\n" + "=".repeat(50));
  console.log("✅ Code generation complete!");
  console.log("📊 Stats:");
  console.log(`   Total files: ${results.stats.totalFiles}`);
  console.log(`   Generated: ${results.stats.generated}`);
  console.log(`   Skipped: ${results.stats.skipped}`);
  console.log(`   Failed: ${results.stats.failed}`);
  console.log("=".repeat(50) + "\n");

  results.success = results.stats.failed === 0;
  return results;
}

/* -------------------------------------------------- */
/* ------------ STANDALONE EXECUTION ---------------- */
/* -------------------------------------------------- */

if (import.meta.url === `file://${process.argv[1]}`) {
  runCodegen({
planPath: "./planner_plan.json",
workspace: "./backend",
taskWorkspace: "./",
projectType: "backend",
skipExisting: true,
sessionId: USER_SESSION_ID,
requestId: USER_REQUEST_ID,
  }).catch((err) => {
console.error("❌ Fatal error:", err);
process.exit(1);
  });
}
