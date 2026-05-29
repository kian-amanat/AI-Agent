import fs from "fs";
import path from "path";
import OpenAI from "openai";

import { buildSmartContext } from "./tools/context_engine.js";
import { listBackendFiles } from "./tools/list_backend_files.js";
import { readProjectFile } from "./tools/readProjectFile.js";

/* -------------------------------------------------- */
/* ---------------- CONFIGURATION ------------------- */
/* -------------------------------------------------- */

const PROJECT_ROOT = process.cwd();

const DEFAULT_CONFIG = {
  planPath: "./planner_plan.json",
  workspace: "./",
  taskWorkspace: "./",
  model: "gpt-4.1",
  temperature: 0.1,
  apiKey: process.env.OPENAI_API_KEY || "sk-Sy5TxZ3dcQAfM00dTwH5p8HqQ8hCqh2sf9TzNOfIfTYUmMnD",
  baseURL: process.env.OPENAI_BASE_URL || "https://api.gapgpt.app/v1",
  skipExisting: true,
  maxContextFiles: 10,
  perFileMaxContextFiles: 8,
  dependencyDepth: 2,
  perFileDependencyDepth: 2,
};

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

async function readWorkspaceContext(workspaceRoot) {
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
      context += `${item.is_dir ? "DIR " : "FILE"}: ${item.path}${meta.length ? ` (${meta.join(", ")})` : ""}\n`;
    }
  } else {
    context += "<tree unavailable>\n";
  }

  return context;
}

function mergeContexts(...contexts) {
  return contexts
    .filter(Boolean)
    .join("\n\n")
    .trim();
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

async function readExistingFileContent(workspaceRoot, relativeFile) {
  const fullPath = resolveFilePath(workspaceRoot, relativeFile);
  if (!fs.existsSync(fullPath)) return "";

  try {
    const res = await readProjectFile({
      path: path.relative(PROJECT_ROOT, fullPath).replace(/\\/g, "/"),
      maxBytes: 200000,
    });

    if (!res?.success) return "";
    return String(res.content || "");
  } catch {
    return "";
  }
}

function formatSmartContext(ctx, title = "context") {
  if (!ctx) return "";

  const parts = [];

  if (Array.isArray(ctx.relevantFiles) && ctx.relevantFiles.length > 0) {
    parts.push(`=== ${title}: relevant files ===\n${ctx.relevantFiles.join("\n")}`);
  }

  if (Array.isArray(ctx.files) && ctx.files.length > 0) {
    parts.push(`=== ${title}: selected files ===\n${ctx.files.join("\n")}`);
  }

  if (Array.isArray(ctx.chunks) && ctx.chunks.length > 0) {
    parts.push(
      `=== ${title}: chunks ===\n${ctx.chunks
        .map((c) => `FILE: ${c.path}\n${String(c.content || "").slice(0, 1800)}`)
        .join("\n---\n")}`
    );
  }

  if (ctx.dependencyGraph && Object.keys(ctx.dependencyGraph).length > 0) {
    parts.push(
      `=== ${title}: dependency graph ===\n${JSON.stringify(ctx.dependencyGraph, null, 2)}`
    );
  }

  return parts.join("\n\n");
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
${formatSmartContext(globalSmartContext, "global")}

File-specific semantic context:
${formatSmartContext(fileSmartContext, "file")}

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

function writeFile(filePath, content) {
  ensureDirForFile(filePath);
  fs.writeFileSync(filePath, content, "utf8");
}

/* -------------------------------------------------- */
/* ---------------- MAIN FUNCTION ------------------- */
/* -------------------------------------------------- */

export async function runCodegen(options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };

  console.log("⚙️ Starting code generation...\n");
  console.log(`📁 Workspace: ${config.workspace}`);
  console.log(`📋 Plan: ${config.planPath}`);
  console.log(`🎯 Project Type: ${config.projectType || "fullstack"}\n`);

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

  const workspaceContext = await readWorkspaceContext(workspaceRoot);

  const globalSmartContext = await buildSmartContext({
    userMessage: [plan.name, plan.goal, plan.summary, plan.task_scope]
      .filter(Boolean)
      .join(" "),
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
    const fullPath = resolveFilePath(workspaceRoot, relativeFile);
    const progress = `[${i + 1}/${fileEntries.length}]`;

    const currentContent = await readExistingFileContent(workspaceRoot, relativeFile);

    const isModifyAction = entry.action === "modify";
    const shouldSkip =
      config.skipExisting &&
      !isModifyAction &&
      !fileNeedsGeneration(fullPath);

    if (shouldSkip) {
      console.log(`   ⏭️  ${progress} Skipping (already implemented): ${relativeFile}`);
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
      const projectType = config.projectType || plan.task_scope || plan.project_type || "fullstack";

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

      writeFile(fullPath, code);

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
  console.log(`📊 Stats:`);
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
  }).catch((err) => {
    console.error("❌ Fatal error:", err);
    process.exit(1);
  });
}