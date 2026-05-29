import path from "path";
import fs from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import OpenAI from "openai";

import { buildSmartContext } from "./tools/context_engine.js";
import { listBackendFiles } from "./tools/list_backend_files.js";
import { readProjectFile } from "./tools/readProjectFile.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------- Config ----------
const PROJECT_ROOT = process.cwd();
const BACKEND_ROOT = path.join(PROJECT_ROOT, "backend");
const FRONTEND_ROOT = path.join(PROJECT_ROOT, "frontend");
const BACKEND_CWD_REL = path.relative(PROJECT_ROOT, BACKEND_ROOT) || "backend";
const FRONTEND_CWD_REL = path.relative(PROJECT_ROOT, FRONTEND_ROOT) || "frontend";

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.gapgpt.app/v1";
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || "sk-Sy5TxZ3dcQAfM00dTwH5p8HqQ8hCqh2sf9TzNOfIfTYUmMnD";

if (!OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY env var.");
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL,
});

// --------- Utils ----------
function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function stripPathNoise(value) {
  return String(value || "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[),.;:]+$/g, "");
}

function containsWord(text, word) {
  const regex = new RegExp(`\\b${word}\\b`, "i");
  return regex.test(text);
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function extractLikelyJsonObject(raw) {
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return raw.slice(first, last + 1);
}

function inferTaskScopeFromType(taskType) {
  if (taskType.startsWith("frontend_")) return "frontend";
  if (taskType.startsWith("backend_")) return "backend";
  if (taskType === "fullstack_feature") return "fullstack";
  return "unknown";
}

// --------- Detect task type ----------
function detectTaskType(userMessage) {
  const msg = normalizeText(userMessage);

  const frontendSignals = [
    "sidebar",
    "component",
    "page",
    "ui",
    "layout",
    "navbar",
    "header",
    "footer",
    "card",
    "modal",
    "drawer",
    "chatgpt",
    "chatbot",
    "react",
    "next",
    "tailwind",
    "lucide",
    "animation",
    "input",
    "chat",
  ];

  const backendSignals = [
    "api",
    "endpoint",
    "route",
    "server",
    "database",
    "schema",
    "auth",
    "controller",
    "service",
    "repository",
    "fastify",
    "express",
  ];

  const testSignals = ["test", "spec", "vitest", "jest", "playwright", "e2e"];

  const bugSignals = ["bug", "fix", "error", "issue", "broken", "crash"];

  const refactorSignals = ["refactor", "cleanup", "optimize", "reorganize"];

  const hasFrontend = frontendSignals.some((kw) => containsWord(msg, kw));
  const hasBackend = backendSignals.some((kw) => containsWord(msg, kw));
  const hasTests = testSignals.some((kw) => containsWord(msg, kw));
  const hasBug = bugSignals.some((kw) => containsWord(msg, kw));
  const hasRefactor = refactorSignals.some((kw) => containsWord(msg, kw));

  if (hasTests) return "test_generation";
  if (hasBug) return "bug_fix";
  if (hasRefactor) return "refactor";

  if (hasFrontend && containsWord(msg, "page")) return "frontend_page";
  if (hasFrontend) return "frontend_component";
  if (hasBackend) return "backend_api";

  return "feature";
}

// --------- Detect project scope ----------
function detectProjectScope(userMessage) {
  const msg = normalizeText(userMessage);

  const frontendKeywords = [
    "frontend",
    "front-end",
    "ui",
    "react",
    "vue",
    "component",
    "page",
    "routing",
    "state management",
    "sidebar",
    "chatbot",
    "next",
    "tailwind",
    "animation",
  ];
  const backendKeywords = [
    "backend",
    "back-end",
    "api",
    "server",
    "database",
    "auth",
    "fastify",
    "express",
    "endpoint",
    "route",
  ];

  const hasFrontend = frontendKeywords.some((kw) => msg.includes(kw));
  const hasBackend = backendKeywords.some((kw) => msg.includes(kw));

  if (hasFrontend && hasBackend) return "fullstack";
  if (hasFrontend) return "frontend";
  if (hasBackend) return "backend";
  return "unknown";
}

function extractCandidateFilePaths(userMessage) {
  const msg = String(userMessage || "");
  const pathRegex =
    /(?:\/?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.(?:tsx?|jsx?|css|scss|md|json|ya?ml|html|xml|mjs|cjs|ts|js))/g;

  const matches = msg.match(pathRegex) || [];
  return uniq(matches.map(stripPathNoise));
}

function buildResolvedPathCandidates(candidatePath) {
  const cleaned = stripPathNoise(candidatePath).replace(/^\/+/, "");
  const variants = new Set([cleaned]);

  if (cleaned.startsWith("frontend/")) {
    variants.add(cleaned.slice("frontend/".length));
  }
  if (cleaned.startsWith("backend/")) {
    variants.add(cleaned.slice("backend/".length));
  }

  const resolved = [];
  for (const variant of variants) {
    if (!variant) continue;
    resolved.push(path.join(PROJECT_ROOT, variant));
    resolved.push(path.join(FRONTEND_ROOT, variant));
    resolved.push(path.join(BACKEND_ROOT, variant));
  }

  return uniq(resolved);
}

function formatSmartContext(ctx, title = "smart-context") {
  if (!ctx) return "";

  const parts = [];

  if (Array.isArray(ctx.relevantFiles) && ctx.relevantFiles.length > 0) {
    parts.push(`=== ${title}: relevant files ===\n${ctx.relevantFiles.join("\n")}`);
  }

  if (Array.isArray(ctx.files) && ctx.files.length > 0) {
    parts.push(`=== ${title}: selected files ===\n${ctx.files.join("\n")}`);
  }

  if (Array.isArray(ctx.chunks) && ctx.chunks.length > 0) {
    const chunkText = ctx.chunks
      .map((c) => `FILE: ${c.path}\n${String(c.content || "").slice(0, 2000)}`)
      .join("\n---\n");
    parts.push(`=== ${title}: file chunks ===\n${chunkText}`);
  }

  if (ctx.dependencyGraph && Object.keys(ctx.dependencyGraph).length > 0) {
    parts.push(
      `=== ${title}: dependency graph ===\n${JSON.stringify(ctx.dependencyGraph, null, 2)}`
    );
  }

  return parts.join("\n\n");
}

function buildSystemPrompt(taskType, taskScope) {
  return `
You are a senior software planning agent.

Your job is to produce a task-level implementation plan that is exact, practical, and aligned with the user's request.

Rules:
- Return ONLY valid JSON.
- No markdown.
- No code fences.
- No explanations outside JSON.
- The output must be directly usable by a code generation agent.
- If the request is about one UI task, keep the plan focused and small.
- Use the workspace context carefully.
- Prefer existing project conventions.
- Do not invent unrelated files.

Output schema:
{
  "task_type": "task",
  "name": string,
  "task_scope": "frontend" | "backend" | "fullstack" | "unknown",
  "goal": string,
  "summary": string,
  "context_assumptions": string[],
  "files_to_create": [
    {
      "path": string,
      "purpose": string,
      "content": string
    }
  ],
  "files_to_modify": [
    {
      "path": string,
      "purpose": string,
      "content": string
    }
  ],
  "dependencies": string[],
  "constraints": string[],
  "acceptance_criteria": string[],
  "notes": string
}

Detected task type hint: ${taskType}
Detected task scope: ${taskScope}
`.trim();
}

async function summarizeProjectStructure(scope) {
  const summary = { backend: "", frontend: "" };

  const collect = async (dirLabel, dirRelPath) => {
    try {
      const res = await listBackendFiles({
        dir: dirRelPath,
        maxDepth: 5,
        includeFiles: true,
        includeDirs: true,
        includeMeta: false,
      });

      if (res?.success && Array.isArray(res.files)) {
        const lines = res.files.map((e) => `${e.is_dir ? "DIR " : "FILE"}: ${e.path}`);
        return lines.length ? lines.join("\n") : `<${dirLabel} dir is empty>`;
      }

      return `<${dirLabel} dir is empty>`;
    } catch (e) {
      return `<error: ${String(e)}>`;
    }
  };

  if (scope === "backend" || scope === "fullstack" || scope === "unknown") {
    summary.backend = await collect("backend", BACKEND_CWD_REL);
  }

  if (scope === "frontend" || scope === "fullstack" || scope === "unknown") {
    summary.frontend = await collect("frontend", FRONTEND_CWD_REL);
  }

  return summary;
}

async function readExactReferencedFiles(userMessage) {
  const candidatePaths = extractCandidateFilePaths(userMessage);
  if (!candidatePaths.length) return [];

  const snippets = [];
  const seen = new Set();

  for (const candidate of candidatePaths) {
    const resolvedCandidates = buildResolvedPathCandidates(candidate);

    for (const absPath of resolvedCandidates) {
      const relPath = path.relative(PROJECT_ROOT, absPath).replace(/\\/g, "/");

      if (seen.has(relPath)) continue;
      if (!fs.existsSync(absPath)) continue;

      let stat;
      try {
        stat = fs.statSync(absPath);
      } catch {
        continue;
      }

      if (!stat.isFile()) continue;

      try {
        const res = await readProjectFile({ path: relPath, maxBytes: 120000 });
        const content = typeof res === "string" ? res : res?.content || "";
        if (!content) continue;

        snippets.push({
          path: relPath,
          content: content.slice(0, 3000),
        });

        seen.add(relPath);

        if (snippets.length >= 6) return snippets;
      } catch {
        // ignore
      }
    }
  }

  return snippets;
}

function buildUserPrompt({
  userMessage,
  taskType,
  taskScope,
  projectStructure,
  smartContextText,
  exactFilesText,
}) {
  return `
User request:
${userMessage}

Task classification:
- task_type: ${taskType}
- task_scope: ${taskScope}

Project structure:
--- frontend ---
${projectStructure.frontend || "<none>"}

--- backend ---
${projectStructure.backend || "<none>"}

Exact referenced file snippets:
${exactFilesText || "<none>"}

Advanced semantic workspace context:
${smartContextText || "<none>"}

Task:
Create a task-level implementation plan for this request.
Focus only on the requested feature.
Do not expand into unrelated architecture work.
Do not add deployment, CI/CD, or unrelated refactors.
`.trim();
}

async function runPlanner(userMessage) {
  if (!userMessage || typeof userMessage !== "string" || !userMessage.trim()) {
    throw new Error("userMessage is required");
  }

  console.log("🧠 Task planner started...");
  console.log("Project root:", PROJECT_ROOT);
  console.log("Goal:", userMessage);

  const taskType = detectTaskType(userMessage);
  let taskScope = detectProjectScope(userMessage);

  if (taskScope === "unknown") {
    taskScope = inferTaskScopeFromType(taskType);

    if (taskScope === "unknown") {
      const scopeDetectionResp = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [
          {
            role: "system",
            content:
              'You are a task scope detector. Given a user request, determine if it is "frontend", "backend", or "fullstack". Reply with ONLY one word: frontend, backend, or fullstack.',
          },
          { role: "user", content: userMessage },
        ],
        temperature: 0,
        max_tokens: 10,
      });

      const detectedScope = scopeDetectionResp.choices?.[0]?.message?.content?.trim().toLowerCase();

      taskScope = ["frontend", "backend", "fullstack"].includes(detectedScope)
        ? detectedScope
        : "fullstack";
    }
  }

  console.log("📊 Detected task type:", taskType);
  console.log("📦 Detected scope:", taskScope);

  const projectStructure = await summarizeProjectStructure(taskScope);
  const smartContext = await buildSmartContext({
    userMessage,
    maxFiles: 10,
    dependencyDepth: 2,
  });

  const exactFiles = await readExactReferencedFiles(userMessage);

  const smartContextText = formatSmartContext(smartContext, "workspace");
  const exactFilesText = exactFiles.length
    ? exactFiles
        .map((file) => `FILE: ${file.path}\nSNIPPET:\n${file.content}\n---`)
        .join("\n")
    : "";

  const systemPrompt = buildSystemPrompt(taskType, taskScope);
  const userPrompt = buildUserPrompt({
    userMessage,
    taskType,
    taskScope,
    projectStructure,
    smartContextText,
    exactFilesText,
  });

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1,
  });

  const raw = resp.choices?.[0]?.message?.content || "";

  let parsed = safeJsonParse(raw);
  if (!parsed.ok) {
    const candidate = extractLikelyJsonObject(raw);
    if (candidate) parsed = safeJsonParse(candidate);
  }

  if (!parsed.ok) {
    console.error("❌ Planner returned non-JSON. Raw:");
    console.error(raw);
    throw parsed.error;
  }

  const plan = parsed.value;

  console.log("\n📋 Generated Task Plan (JSON):\n");
  console.log(JSON.stringify(plan, null, 2));

  const outPath = path.join(PROJECT_ROOT, "planner_plan.json");
  fs.writeFileSync(outPath, JSON.stringify(plan, null, 2), "utf8");
  console.log(`\n💾 Plan saved to: ${outPath}`);

  return plan;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cliGoal = process.argv.slice(2).join(" ");
  if (!cliGoal) {
    console.error("Usage: node planner.js <your request>");
    process.exit(1);
  }

  runPlanner(cliGoal).catch((err) => {
    console.error("❌ Planner crashed:", err);
    process.exit(1);
  });
}

export { runPlanner };