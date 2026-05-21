// codegen_agent.mjs
import fs from "fs";
import path from "path";
import OpenAI from "openai";

const PLAN_PATH = "./planner_plan.json";
const WORKSPACE = "backend";

const client = new OpenAI({
  apiKey:
    process.env.OPENAI_API_KEY ||
    "sk-Sy5TxZ3dcQAfM00dTwH5p8HqQ8hCqh2sf9TzNOfIfTYUmMnD",
  baseURL: process.env.OPENAI_BASE_URL || "https://api.gapgpt.app/v1",
});

/* -------------------------------------------------- */
/* ---------------- SYSTEM PROMPT ------------------- */
/* -------------------------------------------------- */

const SYSTEM_PROMPT = `
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
- خروجی فقط سورس کد خالص فایل باشد.
`.trim();

/* -------------------------------------------------- */

function readPlan() {
  if (!fs.existsSync(PLAN_PATH)) {
    throw new Error("planner_plan.json not found");
  }
  return JSON.parse(fs.readFileSync(PLAN_PATH, "utf8"));
}

/**
 * نرمال‌سازی مسیرهای relative مثل scaffold:
 * - حذف ./ اول
 * - نرمال‌سازی با path.normalize
 */
function normalizeRelativePath(p) {
  if (!p || typeof p !== "string") return "";
  let norm = p.trim();
  if (norm.startsWith("./")) norm = norm.slice(2);
  norm = path.normalize(norm);
  return norm;
}

function fileFullPath(relativePath) {
  const rel = normalizeRelativePath(relativePath);
  return path.join(WORKSPACE, rel);
}

/**
 * تصمیم می‌گیرد آیا فایل نیاز به generation / rewrite دارد یا نه.
 * - اگر وجود ندارد => true
 * - اگر خالی است => true
 * - اگر شامل "TODO" است => true
 * - در غیر این صورت => false (یعنی دست‌کم یک پیاده‌سازی قبلی هست)
 */
function fileNeedsGeneration(filePath) {
  if (!fs.existsSync(filePath)) {
    return true;
  }
  const content = fs.readFileSync(filePath, "utf8").trim();
  if (content === "") return true;
  if (content.includes("TODO")) return true;
  return false;
}

/* -------------------------------------------------- */
/* ----------- PROJECT CONTEXT BUILDER ------------- */
/* -------------------------------------------------- */

function walkDir(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;

  const files = fs.readdirSync(dir);
  for (const file of files) {
    const full = path.join(dir, file);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      walkDir(full, fileList);
    } else {
      // خروجی structure نسبی نسبت به WORKSPACE
      const rel = path.relative(WORKSPACE, full);
      fileList.push(rel);
    }
  }
  return fileList;
}

function readProjectContext() {
  let context = "";

  const pkgPath = fileFullPath("package.json");
  if (fs.existsSync(pkgPath)) {
    context += "\n--- package.json ---\n";
    context += fs.readFileSync(pkgPath, "utf8");
  }

  const tsconfigPath = fileFullPath("tsconfig.json");
  if (fs.existsSync(tsconfigPath)) {
    context += "\n--- tsconfig.json ---\n";
    context += fs.readFileSync(tsconfigPath, "utf8");
  }

  const files = walkDir(WORKSPACE);
  context += "\n--- Project Structure ---\n";
  context += files.join("\n");

  return context;
}

/* -------------------------------------------------- */

function cleanGeneratedCode(content) {
  let cleaned = String(content).trim();
  if (cleaned.startsWith("```")) {
cleaned = cleaned
.replace(/^```[a-zA-Z]*\n?/, "")
      .replace(/```$/, "")
.trim();
  }
  return cleaned;
}

/* -------------------------------------------------- */

async function generateCode(relativeFile, stepDescription, projectContext) {
  const prompt = `
Target file:
${relativeFile}

Step description:
${stepDescription}

Project context:
${projectContext}

Strict requirements:
- Only use existing files from Project Structure.
- Do not invent new modules.
- All imports must be valid.
- Code must compile with tsc.
- No explanations, only pure code.
`.trim();

  const response = await client.chat.completions.create({
model: "gpt-4.1",
temperature: 0.1,
messages: [
{ role: "system", content: SYSTEM_PROMPT },
{ role: "user", content: prompt },
],
  });

  const raw = response.choices?.[0]?.message?.content || "";
  return cleanGeneratedCode(raw);
}

/* -------------------------------------------------- */

function writeFile(filePath, content) {
  fs.writeFileSync(filePath, content);
}

/* -------------------------------------------------- */

async function run() {
  console.log("⚙️ Starting enhanced code generation...\n");

  const plan = readPlan();
  const projectContext = readProjectContext();

  if (!plan.phases || !Array.isArray(plan.phases)) {
throw new Error("Invalid plan structure: phases missing or not array");
  }

  for (const phase of plan.phases) {
console.log(`\n🚀 PHASE: ${phase.title}`);

if (!phase.steps || !Array.isArray(phase.steps)) continue;

for (const step of phase.steps) {
console.log(`   🔹 STEP: ${step.id}`);

if (!step.files || !Array.isArray(step.files)) continue;

for (const relativeFile of step.files) {
const fullPath = fileFullPath(relativeFile);

if (!fileNeedsGeneration(fullPath)) {
console.log(`   ⚠️ Skipping (already implemented): ${relativeFile}`);
continue;
}

console.log(`   🤖 Generating: ${relativeFile}`);

try {
const code = await generateCode(
relativeFile,
step.description || "",
projectContext
);

if (!code.trim()) {
console.error(`   ❌ Empty output for ${relativeFile}`);
continue;
}

writeFile(fullPath, code);
console.log(`   ✅ Written: ${relativeFile}`);
} catch (err) {
console.error(`   ❌ Error on ${relativeFile}:`, err.message);
}
}
}
  }

  console.log("\n✅ Code generation complete.");
}

run();
