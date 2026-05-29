// scaffold_agent.mjs - با Real-time Logging بهبود یافته
import fs from "fs";
import path from "path";

/* -------------------------------------------------- */
/* ---------------- CONFIGURATION ------------------- */
/* -------------------------------------------------- */

const DEFAULT_CONFIG = {
  planPath: "./planner_plan.json",
  workspace: "./",          // ← تغییر: project root
  overwrite: true,          // ← تغییر: همیشه overwrite
  fileTemplate: "// TODO: implement\n",
  verbose: true,
};

/* -------------------------------------------------- */
/* ---------------- LOGGING HELPERS ----------------- */
/* -------------------------------------------------- */

class Logger {
  constructor(verbose = true) {
    this.verbose = verbose;
    this.startTime = Date.now();
  }

  phase(title, index, total) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`🚀 PHASE ${index}/${total}: ${title}`);
    console.log(`${"=".repeat(60)}`);
  }

  step(id, description, index, total) {
    console.log(`\n📍 STEP ${index}/${total}: ${id}`);
    if (description && this.verbose) {
      console.log(`   💬 ${description}`);
    }
  }

  fileCreated(file, index, total) {
    const progress = `[${index}/${total}]`;
    console.log(`   ✅ ${progress} Created: ${file}`);
  }

  fileSkipped(file, reason, index, total) {
    const progress = `[${index}/${total}]`;
    console.log(`   ⏭️  ${progress} Skipped: ${file} (${reason})`);
  }

  fileError(file, error, index, total) {
    const progress = `[${index}/${total}]`;
    console.error(`   ❌ ${progress} Error: ${file}`);
    console.error(`      └─ ${error}`);
  }

  warning(message) {
    console.warn(`   ⚠️  ${message}`);
  }

  info(message) {
    if (this.verbose) {
      console.log(`   ℹ️  ${message}`);
    }
  }

  summary(results) {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(2);

    console.log(`\n${"=".repeat(60)}`);
    console.log(`✅ SCAFFOLD COMPLETE`);
    console.log(`${"=".repeat(60)}`);
    console.log(`⏱️  Time: ${elapsed}s`);
    console.log(`📊 Statistics:`);
    console.log(`   📝 Total files: ${results.stats.totalFiles}`);
    console.log(`   ✅ Created: ${results.stats.created}`);
    console.log(`   ⏭️  Skipped: ${results.stats.skipped}`);
    console.log(`   ❌ Failed: ${results.stats.failed}`);

    if (results.stats.created > 0) {
      const successRate = (
        (results.stats.created / results.stats.totalFiles) *
        100
      ).toFixed(1);
      console.log(`   📈 Success rate: ${successRate}%`);
    }

    console.log(`${"=".repeat(60)}\n`);

    if (results.errors.length > 0) {
      console.log(`\n🔥 ERRORS (${results.errors.length}):`);
      results.errors.forEach((err, i) => {
        console.error(`   ${i + 1}. ${err.file}`);
        console.error(`      └─ ${err.error}`);
      });
      console.log("");
    }

    if (results.filesSkipped.length > 5) {
      console.log(
        `\n⏭️  SKIPPED FILES (showing first 5 of ${results.filesSkipped.length}):`
      );
      results.filesSkipped.slice(0, 5).forEach((file, i) => {
        console.log(`   ${i + 1}. ${file}`);
      });
      console.log(`   ... and ${results.filesSkipped.length - 5} more\n`);
    } else if (results.filesSkipped.length > 0) {
      console.log(`\n⏭️  SKIPPED FILES (${results.filesSkipped.length}):`);
      results.filesSkipped.forEach((file, i) => {
        console.log(`   ${i + 1}. ${file}`);
      });
      console.log("");
    }
  }
}

/* -------------------------------------------------- */
/* ---------------- HELPER FUNCTIONS ---------------- */
/* -------------------------------------------------- */

function normalizeRelativePath(p) {
  if (!p || typeof p !== "string") return "";
  let norm = p.trim();
  if (norm.startsWith("./")) norm = norm.slice(2);
  norm = path.normalize(norm);
  return norm;
}

function ensureDirectory(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function createFile(fullPath, content, overwrite) {
  if (fs.existsSync(fullPath) && !overwrite) {
    return { created: false, reason: "already_exists" };
  }

  ensureDirectory(fullPath);
  fs.writeFileSync(fullPath, content, "utf8");

  return { created: true };
}

function getFileTemplate(filePath, defaultTemplate) {
  const ext = path.extname(filePath);

  const templates = {
    ".ts": "// TODO: implement\nexport {};\n",
    ".tsx": "// TODO: implement\nexport {};\n",
    ".js": "// TODO: implement\n",
    ".jsx": "// TODO: implement\n",
    ".json": "{\n  \n}\n",
    ".css": "/* TODO: add styles */\n",
    ".scss": "/* TODO: add styles */\n",
    ".html":
      "<!DOCTYPE html>\n<html>\n<head>\n  <title>TODO</title>\n</head>\n<body>\n  \n</body>\n</html>\n",
    ".md": "# TODO\n\n",
    ".env": "# Environment variables\n",
    ".env.example": "# Environment variables example\n",
    ".gitignore": "node_modules/\ndist/\nbuild/\n.env\n.DS_Store\n",
    ".dockerignore": "node_modules/\ndist/\nbuild/\n.env\n.git/\n",
    Dockerfile: "# TODO: Add Dockerfile\n",
    "README.md": "# Project\n\nTODO: Add description\n",
    "package.json": '{\n  "name": "project",\n  "version": "1.0.0"\n}\n',
  };

  const basename = path.basename(filePath);
  if (templates[basename]) return templates[basename];
  return templates[ext] || defaultTemplate;
}

/* -------------------------------------------------- */
/* ----------- UNIFIED PLAN FILE EXTRACTOR ---------- */
/* -------------------------------------------------- */

/**
 * هر دو ساختار task-level و project-level رو normalize می‌کنه
 * خروجی: آرایه‌ای از { path, content }
 */
function extractFilesFromPlan(plan, defaultTemplate) {
  const files = [];

  // ── حالت task-level ──────────────────────────────
  // ساختار: { files_to_create: [...], files_to_modify: [...] }
  if (
    Array.isArray(plan.files_to_create) ||
    Array.isArray(plan.files_to_modify)
  ) {
    const allEntries = [
      ...(plan.files_to_create || []),
      ...(plan.files_to_modify || []),
    ];

    for (const entry of allEntries) {
      if (!entry?.path) continue;
      files.push({
        path: entry.path,
        content: entry.content || null, // null = از template استفاده می‌شه
      });
    }

    return files;
  }

  // ── حالت files array مستقیم ──────────────────────
  // ساختار: { files: [{ path, content, action }] }
  if (Array.isArray(plan.files)) {
    for (const entry of plan.files) {
      if (!entry?.path) continue;
      files.push({
        path: entry.path,
        content: entry.content || null,
      });
    }
    return files;
  }

  // ── حالت project-level (phases/steps) ────────────
  if (Array.isArray(plan.phases)) {
    for (const phase of plan.phases) {
      if (!Array.isArray(phase.steps)) continue;
      for (const step of phase.steps) {
        if (!Array.isArray(step.files)) continue;
        for (const f of step.files) {
          // ممکنه string باشه یا object
          if (typeof f === "string") {
            files.push({ path: f, content: null });
          } else if (f?.path) {
            files.push({ path: f.path, content: f.content || null });
          }
        }
      }
    }
    return files;
  }

  return files;
}

/* -------------------------------------------------- */
/* ---------------- MAIN FUNCTION ------------------- */
/* -------------------------------------------------- */

export async function runScaffold(options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  const logger = new Logger(config.verbose);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`📦 SCAFFOLD AGENT - Starting...`);
  console.log(`${"=".repeat(60)}`);
  console.log(`📁 Workspace: ${config.workspace}`);
  console.log(`📋 Plan: ${config.planPath}`);
  console.log(`🔄 Overwrite: ${config.overwrite}`);
  console.log(`${"=".repeat(60)}\n`);

  const results = {
    success: true,
    filesCreated: [],
    filesSkipped: [],
    errors: [],
    stats: {
      totalFiles: 0,
      created: 0,
      skipped: 0,
      failed: 0,
    },
  };

  // ✅ Ensure workspace exists
  if (!fs.existsSync(config.workspace)) {
    fs.mkdirSync(config.workspace, { recursive: true });
    logger.info(`Created workspace: ${config.workspace}`);
  } else {
    logger.info(`Workspace exists: ${config.workspace}`);
  }

  // ✅ Read and validate plan
  if (!fs.existsSync(config.planPath)) {
    throw new Error(`Plan file not found: ${config.planPath}`);
  }

  const plan = JSON.parse(fs.readFileSync(config.planPath, "utf8"));

  // ✅ Extract files (هر دو ساختار رو handle می‌کنه)
  const fileEntries = extractFilesFromPlan(plan, config.fileTemplate);

  if (fileEntries.length === 0) {
    console.warn("⚠️  No files found in plan. Check plan structure.");
    return results;
  }

  const isTaskMode =
    plan.task_type === "task" ||
    Array.isArray(plan.files_to_create) ||
    Array.isArray(plan.files_to_modify);

  console.log(`📊 Plan Analysis:`);
  console.log(`   Mode: ${isTaskMode ? "task-level" : "project-level"}`);
  console.log(`   Files: ${fileEntries.length}`);
  console.log(`   task_type: ${plan.task_type || "N/A"}`);
  console.log("");

  // ✅ Process all files
  for (let i = 0; i < fileEntries.length; i++) {
    const entry = fileEntries[i];
    results.stats.totalFiles++;

    const normalizedRel = normalizeRelativePath(entry.path);

    if (!normalizedRel) {
      logger.warning(`Invalid file path: ${entry.path}`);
      results.filesSkipped.push(entry.path);
      results.stats.skipped++;
      continue;
    }

    const fullPath = path.join(config.workspace, normalizedRel);

    // محتوا: از plan اگر موجود بود، وگرنه template
    const content =
      entry.content !== null && entry.content !== undefined
        ? entry.content
        : getFileTemplate(fullPath, config.fileTemplate);

    try {
      const result = createFile(fullPath, content, config.overwrite);

      if (result.created) {
        logger.fileCreated(normalizedRel, i + 1, fileEntries.length);
        results.filesCreated.push(normalizedRel);
        results.stats.created++;

        if (config.onProgress) {
          config.onProgress({
            type: "file_created",
            file: normalizedRel,
            progress: (i + 1) / fileEntries.length,
          });
        }
      } else {
        logger.fileSkipped(
          normalizedRel,
          result.reason,
          i + 1,
          fileEntries.length
        );
        results.filesSkipped.push(normalizedRel);
        results.stats.skipped++;
      }
    } catch (err) {
      logger.fileError(normalizedRel, err.message, i + 1, fileEntries.length);
      results.errors.push({ file: normalizedRel, error: err.message });
      results.stats.failed++;
    }
  }

  // ✅ Final summary
  logger.summary(results);

  results.success = results.stats.failed === 0;
  return results;
}

/* -------------------------------------------------- */
/* ------------ STANDALONE EXECUTION ---------------- */
/* -------------------------------------------------- */

if (import.meta.url === `file://${process.argv[1]}`) {
  runScaffold({
    planPath: "./planner_plan.json",
    workspace: "./",
    overwrite: true,
    verbose: true,
  }).catch((err) => {
    console.error("\n❌ Fatal error:", err.message);
    console.error(err.stack);
    process.exit(1);
  });
}
