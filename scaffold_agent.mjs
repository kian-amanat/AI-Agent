// scaffold_agent.mjs
import fs from "fs";
import path from "path";

const PLAN_PATH = "./planner_plan.json";
const WORKSPACE = "backend"; // backend workspace folder

function readPlan() {
  if (!fs.existsSync(PLAN_PATH)) {
    throw new Error("planner_plan.json not found.");
  }

  const raw = fs.readFileSync(PLAN_PATH, "utf8");
  return JSON.parse(raw);
}

function ensureWorkspace() {
  if (!fs.existsSync(WORKSPACE)) {
    fs.mkdirSync(WORKSPACE, { recursive: true });
    console.log("📁 Created workspace:", WORKSPACE);
  } else {
    console.log("📁 Workspace already exists:", WORKSPACE);
  }
}

function ensureDirectory(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log("📂 Created directory:", dir);
  }
}

/**
 * نرمال‌سازی مسیرهای داخل پلن:
 * - حذف ./ اول
 * - تبدیل backslash به slash روی ویندوز
 */
function normalizeRelativePath(p) {
  if (!p || typeof p !== "string") return "";
  let norm = p.trim();
  if (norm.startsWith("./")) norm = norm.slice(2);
  // path.normalize برای سیستم، ولی برای نمایش اهمیتی ندارد
  norm = path.normalize(norm);
  return norm;
}

function createEmptyFile(relativePath) {
  const normalizedRel = normalizeRelativePath(relativePath);
  if (!normalizedRel) {
    console.warn("⚠️ Skip empty/invalid file path in plan:", relativePath);
    return;
  }

  const fullPath = path.join(WORKSPACE, normalizedRel);

  // اگر فایل از قبل وجود دارد، هیچ‌کاری نکن
  if (fs.existsSync(fullPath)) {
    console.log("⚠️ Already exists, skipping:", fullPath);
    return;
  }

  // فقط اگر وجود ندارد، فولدرهای والد را بساز
  ensureDirectory(fullPath);

  fs.writeFileSync(fullPath, "// TODO: implement\n");
  console.log("✅ Created:", fullPath);
}

function run() {
  console.log("📦 Starting scaffold process...\n");

  ensureWorkspace();

  const plan = readPlan();

  if (!plan.phases || !Array.isArray(plan.phases)) {
    throw new Error("Invalid plan structure: missing phases");
  }

  for (const phase of plan.phases) {
    console.log(`\n🚀 PHASE: ${phase.title}`);

    if (!phase.steps || !Array.isArray(phase.steps)) continue;

    for (const step of phase.steps) {
      console.log(`   🔹 STEP: ${step.id}`);

      if (!step.files || !Array.isArray(step.files)) continue;

      for (const file of step.files) {
        createEmptyFile(file);
      }
    }
  }

  console.log("\n✅ Scaffold complete.");
}

run();
