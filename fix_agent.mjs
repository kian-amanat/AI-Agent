// fix_agent.mjs
import "dotenv/config";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { exec } from "child_process";
import { promisify } from "util";
import OpenAI from "openai";

const execAsync = promisify(exec);

/* ================================================== */
/* ================== CONFIGURATION ================= */
/* ================================================== */

const DEFAULT_CONFIG = {
  // Project settings
  workspace: "./workspace",
  projectType: "backend", // backend | frontend | fullstack
  
  // LLM settings
  model: "gpt-4o-mini",
  temperature: 0,
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || "https://api.gapgpt.app/v1",
  
  // Loop control
  maxLoops: 6,
  maxRetries: 2,
  
  // Token optimization
  maxErrorChars: 15000,
  maxContextChars: 25000,
  maxFullFileChars: 35000,
  
  // File limits
  maxFiles: 6,
  maxFilesDeep: 12,
  fileHeadLines: 120,
  fileTailLines: 80,
  fileHeadLinesDeep: 220,
  fileTailLinesDeep: 160,
  
  // Deep mode settings
  deepSendFullFiles: true,
  deepModeThreshold: 1,
  
  // Auto-healing
  autoInstallDeps: true,
  autoInstallTypes: true,
  autoGenerateMissing: true,
  autoCreateShims: true,
  
  // Logging
  debugLLM: true,
  debugDiag: true,
  dryRun: false,
  
  // Output
  outputDir: "./logs",
  
  // Callbacks
  onProgress: null,
  onError: null,
  onSuccess: null,
  onDiagnostic: null,
};

/* ================================================== */
/* ==================== HELPERS ===================== */
/* ================================================== */

function sha256(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function truncate(text, maxChars) {
  if (!text) return "";
  const s = String(text);
  return s.length <= maxChars ? s : s.slice(0, maxChars) + "\n\n... <truncated> ...\n";
}

function ensureDir(absDir) {
  fs.mkdirSync(absDir, { recursive: true });
}

function ensureDirForFile(absPath) {
  ensureDir(path.dirname(absPath));
}

function clean(text) {
  if (!text) return "";
  return String(text).replace(/```json/gi, "").replace(/```/g, "").trim();
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(
    d.getHours()
  )}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function readTextIfExists(absPath) {
  try {
    if (!fs.existsSync(absPath)) return null;
    return fs.readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

function safeJson(obj, fallback = "") {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return fallback;
  }
}

function writeDebugFile(config, rel, content) {
  if (!config.debugLLM) return;
  try {
    const abs = path.join(config.workspace, ".fix_agent", rel);
    ensureDirForFile(abs);
    fs.writeFileSync(abs, String(content || ""), "utf8");
  } catch {}
}

function writeDiagFile(config, rel, content) {
  if (!config.debugDiag) return;
  try {
    const abs = path.join(config.workspace, ".fix_agent", "diagnostics", rel);
    ensureDirForFile(abs);
    fs.writeFileSync(abs, String(content || ""), "utf8");
  } catch {}
}

/* ================================================== */
/* ================ COMMAND EXECUTION =============== */
/* ================================================== */

async function run(cmd, cwd) {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd,
      maxBuffer: 1024 * 1024 * 50,
      env: process.env,
    });
    return { ok: true, stdout: stdout || "", stderr: stderr || "" };
  } catch (err) {
    return {
      ok: false,
      stdout: err?.stdout || "",
      stderr: err?.stderr || err?.message || "",
      code: err?.code || 1,
    };
  }
}

/* ================================================== */
/* ============== PACKAGE MANAGER =================== */
/* ================================================== */

function detectPkgManager(workspace) {
  if (fs.existsSync(path.join(workspace, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(workspace, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(workspace, "package-lock.json"))) return "npm";
  return "npm";
}

function installCommand(workspace, pkgs, { dev = false } = {}) {
  const pm = detectPkgManager(workspace);
  const list = (pkgs || []).join(" ").trim();

  if (!list) {
    if (pm === "pnpm") return "pnpm install";
    if (pm === "yarn") return "yarn install";
    return "npm install";
  }

  if (pm === "pnpm") return dev ? `pnpm add -D ${list}` : `pnpm add ${list}`;
  if (pm === "yarn") return dev ? `yarn add -D ${list}` : `yarn add ${list}`;
  return dev ? `npm install -D ${list}` : `npm install ${list}`;
}

/* ================================================== */
/* ============== ERROR CLASSIFICATION ============== */
/* ================================================== */

/**
 * Classify errors into actionable categories
 */
function classifyErrors(output) {
  const classification = {
    missingModules: [],
    missingTypes: [],
    typeErrors: [],
    syntaxErrors: [],
    importErrors: [],
    configErrors: [],
    otherErrors: [],
  };

  const lines = String(output || "").split("\n");

  for (const line of lines) {
    // Missing modules
    if (/Cannot find module ['"](.+?)['"]/i.test(line)) {
      const match = line.match(/Cannot find module ['"](.+?)['"]/);
      if (match && !match[1].startsWith(".")) {
        classification.missingModules.push(match[1]);
      }
    }

    // Missing type declarations
    if (/Could not find a declaration file for module ['"](.+?)['"]/i.test(line)) {
      const match = line.match(/Could not find a declaration file for module ['"](.+?)['"]/);
      if (match && !match[1].startsWith(".")) {
        classification.missingTypes.push(match[1]);
      }
    }

    // Type errors
    if (/error TS\d+:/i.test(line)) {
      if (/TS2\d{3}/.test(line)) {
        classification.typeErrors.push(line.trim());
      } else if (/TS1\d{3}/.test(line)) {
        classification.syntaxErrors.push(line.trim());
      } else {
        classification.otherErrors.push(line.trim());
      }
    }

    // Import/export errors
    if (/import|export/i.test(line) && /error/i.test(line)) {
      classification.importErrors.push(line.trim());
    }

    // Config errors
    if (/tsconfig|compilerOptions/i.test(line)) {
      classification.configErrors.push(line.trim());
    }
  }

  // Deduplicate
  for (const key of Object.keys(classification)) {
    if (Array.isArray(classification[key])) {
      classification[key] = [...new Set(classification[key])];
    }
  }

  return classification;
}

/* ================================================== */
/* =========== SMART FILE SELECTION ================ */
/* ================================================== */

/**
 * Extract file paths from compiler output
 */
function parseErrorFiles(output, limit) {
  const lines = String(output || "").split("\n");
  const files = new Set();

  const rx = /([a-zA-Z0-9_@./\\-]+?\.(?:d\.ts|ts|tsx|mts|cts|js|jsx|mjs))(?=[(:\s])/g;

  for (const line of lines) {
    let m;
    while ((m = rx.exec(line))) {
      const raw = m[1].replaceAll("\\", "/");
      if (raw.includes("node_modules/")) continue;
      const normalized = raw.startsWith("./") ? raw.slice(2) : raw;
      files.add(normalized);
    }
  }

  return [...files].slice(0, limit);
}

/**
 * Add neighbor files for better context
 */
function addNeighborFiles(files, workspace, config) {
  const set = new Set(files || []);
  
  // Add common utility files
  const candidates = [
    "src/types/index.ts",
    "src/types/fastify.d.ts",
    "src/types/vendor.d.ts",
    "src/utils/index.ts",
    "src/config/index.ts",
  ];

  for (const f of candidates) {
    if (fs.existsSync(path.join(workspace, f))) {
      set.add(f);
    }
  }

  // Add related files based on imports
  for (const file of files) {
    const abs = path.join(workspace, file);
    if (!fs.existsSync(abs)) continue;

    try {
      const content = fs.readFileSync(abs, "utf8");
      const importRegex = /from\s+['"](.+?)['"]/g;
      let match;

      while ((match = importRegex.exec(content))) {
        const importPath = match[1];
        if (importPath.startsWith(".")) {
          const resolved = path.resolve(path.dirname(abs), importPath);
          const rel = path.relative(workspace, resolved).replace(/\\/g, "/");

          for (const ext of [".ts", ".tsx", ".js", ".jsx", ""]) {
            const withExt = rel + ext;
            if (fs.existsSync(path.join(workspace, withExt))) {
              set.add(withExt);
              break;
            }
          }
        }
      }
    } catch {}
  }

  return [...set];
}

/**
 * Check if file exists (with fallback for .js -> .ts)
 */
function fileExistsWithFallback(workspace, relPath) {
  const abs = path.join(workspace, relPath);
  if (fs.existsSync(abs)) return true;

  if (relPath.endsWith(".js")) {
    const base = relPath.slice(0, -3);
    if (fs.existsSync(path.join(workspace, base + ".ts"))) return true;
    if (fs.existsSync(path.join(workspace, base))) return true;
  }

  return false;
}

/**
 * Find missing files
 */
function findMissingFiles(files, workspace) {
  const missing = [];
  for (const f of files || []) {
    if (!fileExistsWithFallback(workspace, f)) {
      missing.push(f);
    }
  }
  return missing;
}

/* ================================================== */
/* ============= SMART FILE READING ================ */
/* ================================================== */

/**
 * Read files with smart truncation
 */
function readFiles(files, workspace, config, deepMode = false) {
  const result = {};

  for (const file of files) {
    const abs = path.join(workspace, file);
    if (!fs.existsSync(abs)) continue;

    try {
      const content = fs.readFileSync(abs, "utf8");
      const lines = content.split("\n");

      // Deep mode: send full file if small enough
      if (deepMode && config.deepSendFullFiles) {
        if (content.length <= config.maxFullFileChars) {
          result[file] = content;
          continue;
        }
      }

      // Normal mode: head + tail
      const headLines = deepMode ? config.fileHeadLinesDeep : config.fileHeadLines;
      const tailLines = deepMode ? config.fileTailLinesDeep : config.fileTailLines;

      const head = lines.slice(0, headLines).join("\n");
      const tail = lines.slice(-tailLines).join("\n");

      result[file] = `${head}\n\n// ... [${lines.length - headLines - tailLines} lines omitted] ...\n\n${tail}`;
    } catch (err) {
      console.error(`⚠️ Failed to read ${file}: ${err.message}`);
    }
  }

  return result;
}

/* ================================================== */
/* =========== PROJECT CONTEXT BUILDER ============= */
/* ================================================== */

/**
 * Build minimal project context
 */
function buildProjectContext(workspace, config) {
  const context = {
    projectType: config.projectType,
    structure: {},
    dependencies: {},
    config: {},
  };

  // 1. Package.json
  const pkgPath = path.join(workspace, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      context.dependencies = {
        runtime: Object.keys(pkg.dependencies || {}),
        dev: Object.keys(pkg.devDependencies || {}),
      };
    } catch {}
  }

  // 2. tsconfig.json
  const tsconfigPath = path.join(workspace, "tsconfig.json");
  if (fs.existsSync(tsconfigPath)) {
    try {
      const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8"));
      context.config.typescript = {
        target: tsconfig.compilerOptions?.target,
        module: tsconfig.compilerOptions?.module,
        moduleResolution: tsconfig.compilerOptions?.moduleResolution,
        strict: tsconfig.compilerOptions?.strict,
      };
    } catch {}
  }

  // 3. Project structure (limited depth)
  const relevantDirs = ["src", "lib", "utils", "types", "routes", "services", "components"];
  for (const dir of relevantDirs) {
    const dirPath = path.join(workspace, dir);
    if (fs.existsSync(dirPath)) {
      context.structure[dir] = listDirectory(dirPath, 2);
    }
  }

  return truncate(JSON.stringify(context, null, 2), config.maxContextChars);
}

function listDirectory(dirPath, maxDepth, currentDepth = 0) {
  if (currentDepth >= maxDepth) return [];

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const result = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;

      if (entry.isDirectory()) {
        const subPath = path.join(dirPath, entry.name);
        result.push({
          name: entry.name,
          type: "dir",
          children: listDirectory(subPath, maxDepth, currentDepth + 1),
        });
      } else {
        result.push({ name: entry.name, type: "file" });
      }
    }

    return result;
  } catch {
    return [];
  }
}

/* ================================================== */
/* ============= STRATEGY BUILDER =================== */
/* ================================================== */

/**
 * Build fix strategy hints based on error classification
 */
function buildStrategyHints(classification) {
  const hints = [];

  const all = JSON.stringify(classification || {});

  // Common patterns
  if (all.includes("autoincrement")) {
    hints.push(
      "- Drizzle SQLite: Replace `autoincrement()` with correct sqlite-core schema pattern for your drizzle-orm version."
    );
  }

  if (all.includes("request.user")) {
    hints.push(
      "- Fastify request.user: Ensure request decoration exists and add TS module augmentation for FastifyRequest.user."
    );
  }

  if (all.includes("verifyToken")) {
    hints.push(
      "- Export mismatch: Ensure utils exports `verifyToken` (named export) OR change import to match existing export."
    );
  }

  if (all.includes("bcrypt")) {
    hints.push(
      "- bcrypt errors: Ensure consistent import style (default vs namespace) and avoid mixing callbacks/promises."
    );
  }

  if (all.includes("TS2835")) {
    hints.push(
      "- TS2835 (ESM import extensions): For NodeNext/Node16, use explicit .js extensions in imports while keeping .ts source files."
    );
  }

  if (all.includes("TS2345")) {
    hints.push(
      "- TS2345 on schema defaults: Ensure default values match declared types. Use Date or SQL expressions for timestamps."
    );
  }

  if (all.includes("Property") && all.includes("does not exist")) {
    hints.push(
      "- Missing properties: Either add the property to the schema/type or stop using it in code."
    );
  }

  // Generic advice
  hints.push("- Fix root causes, not just type assertions.");
  hints.push("- Keep changes minimal and focused on the actual errors.");
  hints.push("- Ensure consistency across imports, types, and implementations.");

  return hints.join("\n");
}

/* ================================================== */
/* =============== PROMPT BUILDER =================== */
/* ================================================== */

/**
 * Build optimized prompt for LLM
 */
function buildFixPrompt(errors, files, projectContext, strategy, meta, config) {
  const sections = [];

  // 1. Role and rules
  sections.push(`You are a senior ${config.projectType} engineer fixing compilation errors.

CRITICAL RULES:
- Return ONLY valid JSON (no markdown, no explanations)
- Keys MUST be existing file paths from FILES object
- Values MUST be FULL file contents (complete replacement)
- Do NOT append or patch. Replace entire file.
- Keep minimal diffs. Don't change unrelated code.
- Ensure consistency across imports/types/tests.`);

  // 2. Previous attempt feedback
  if (meta.attempt > 1 && meta.lastRejectReason) {
    sections.push(`
⚠️ PREVIOUS ATTEMPT REJECTED
Reason: ${meta.lastRejectReason}
Fix the issue and try again.`);
  }

  // 3. Strategy hints
  sections.push(`\nFIX STRATEGY:\n${strategy}`);

  // 4. Meta information
  sections.push(`\nMETA:\n${safeJson(meta)}`);

  // 5. Project context
  sections.push(`\nPROJECT CONTEXT:\n${projectContext}`);

  // 6. Errors (filtered)
  const filteredErrors = filterRelevantErrors(errors);
  sections.push(`\nCOMPILATION ERRORS:\n${truncate(filteredErrors, config.maxErrorChars)}`);

  // 7. Files to fix
  sections.push(`\nFILES TO FIX:\n${safeJson(files)}`);

  // 8. Output format
  sections.push(`
OUTPUT FORMAT (JSON only):
{
  "src/file1.ts": "full corrected content",
  "src/file2.ts": "full corrected content"
}`);

  return sections.join("\n");
}

/**
 * Filter errors to most relevant lines
 */
function filterRelevantErrors(output) {
  const lines = String(output || "").split("\n");
  const keep = [];

  for (const line of lines) {
    if (/error TS\d+:/i.test(line)) keep.push(line);
    if (/\bTS\d+\b/i.test(line)) keep.push(line);
    if (/Cannot find module/i.test(line)) keep.push(line);
    if (/Could not find a declaration/i.test(line)) keep.push(line);
  }

  return keep.join("\n");
}

/* ================================================== */
/* =============== JSON EXTRACTION ================== */
/* ================================================== */

/**
 * Extract JSON from LLM response
 */
function extractJSON(text) {
  if (!text) return null;
  const s = String(text);

  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }

    if (ch === "}") {
      if (depth > 0) depth--;
      if (depth === 0 && start !== -1) {
        const candidate = s.slice(start, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          // keep searching
        }
      }
    }
  }
  return null;
}

/* ================================================== */
/* ============= PATCH VALIDATION =================== */
/* ================================================== */

/**
 * Validate patch content
 */
function isProbablyFullFile(content) {
  if (typeof content !== "string") return false;
  const s = content.trim();
  if (s.length < 120) return false;

  const badStarts = ["Here is", "Sure,", "I will", "Explanation:", "```", "{", "["];
  if (badStarts.some((b) => s.startsWith(b))) return false;

  const looksLikeCode =
/(^|\n)\s*(import|export|type|interface|const|let|class|function)\b/.test(s) ||
/(^|\n)\s*(\/\/|\/\*)/.test(s);

  return looksLikeCode;
}

function isCodeLike(content) {
  if (typeof content !== "string") return false;
  const s = content.trim();
  if (s.length < 30) return false;

  const badStarts = ["Here is", "Sure,", "I will", "Explanation:", "```", "{", "["];
  if (badStarts.some((b) => s.startsWith(b))) return false;

  return (
    /(^|\n)\s*(import|export|type|interface|const|let|class|function)\b/.test(s) ||
    /(^|\n)\s*(\/\/|\/\*)/.test(s) ||
    /(^|\n)\s*([a-zA-Z0-9_$]+\s*[:=]\s*)/.test(s)
  );
}

/**
 * Normalize file path
 */
function normalizeKeyToAllowed(k, allowedSet) {
  if (allowedSet.has(k)) return k;

  // Try swapping .ts <-> .js
  if (k.endsWith(".js")) {
    const k2 = k.slice(0, -3) + ".ts";
    if (allowedSet.has(k2)) return k2;
  }
  if (k.endsWith(".ts")) {
    const k2 = k.slice(0, -3) + ".js";
    if (allowedSet.has(k2)) return k2;
  }

  // Try removing leading ./
  if (k.startsWith("./")) {
    const k2 = k.slice(2);
    if (allowedSet.has(k2)) return k2;
  }

  return null;
}

/* ================================================== */
/* ================ LLM PATCH ======================= */
/* ================================================== */

/**
 * Request patch from LLM
 */
async function requestPatch(errors, files, projectContext, strategy, meta, config) {
  console.log(`🧠 Requesting patch (attempt ${meta.attempt}/${config.maxRetries + 1})...`);

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });

  const prompt = buildFixPrompt(errors, files, projectContext, strategy, meta, config);

  // Save prompt for debugging
  writeDebugFile(config, `loop_${meta.loopIndex}_attempt_${meta.attempt}_prompt.txt`, prompt);

  try {
    const resp = await client.chat.completions.create({
      model: config.model,
      temperature: config.temperature,
      messages: [
        {
          role: "system",
          content: `You are an expert ${config.projectType} engineer. Fix code errors by providing complete file replacements in JSON format.`,
        },
        { role: "user", content: prompt },
      ],
    });

    const raw = resp.choices?.[0]?.message?.content || "";

    // Save raw response
    writeDebugFile(config, `loop_${meta.loopIndex}_attempt_${meta.attempt}_response.txt`, raw);

    return raw;
  } catch (err) {
    console.error(`❌ LLM request failed: ${err.message}`);
    if (config.onError) {
      config.onError({
        type: "llm_error",
        message: err.message,
        meta,
      });
    }
    return null;
  }
}

/**
 * Parse and validate LLM response
 */
function parsePatchResponse(raw, files, meta, config) {
  if (!raw) {
    return { patches: null, rejectReason: "Empty LLM response" };
  }

  const cleaned = clean(raw);

  // Try direct parse
  let parsed = null;
  let parseMode = "direct";

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try extracting JSON
    const extracted = extractJSON(raw);
    if (!extracted) {
      return {
        patches: null,
        rejectReason: "No valid JSON found in response (possibly markdown/explanation)",
      };
    }

    try {
      parsed = JSON.parse(extracted);
      parseMode = "extracted";
    } catch {
      return {
        patches: null,
        rejectReason: "JSON parsing failed even after extraction",
      };
    }
  }

  // Validate structure
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      patches: null,
      rejectReason: "Response is not a valid object",
    };
  }

  // Validate and normalize keys
  const allowed = new Set(Object.keys(files || {}));
  const validPatches = {};

  for (const [kRaw, v] of Object.entries(parsed)) {
    const k = normalizeKeyToAllowed(String(kRaw), allowed);
    if (!k) continue;

    // Validate content
    const deepMode = Boolean(meta?.deepMode);
    const isValid = deepMode ? (isProbablyFullFile(v) || isCodeLike(v)) : isProbablyFullFile(v);

    if (!isValid) continue;

    validPatches[k] = v;
  }

  if (Object.keys(validPatches).length === 0) {
    return {
      patches: null,
      rejectReason: `No valid patches after validation. ParseMode=${parseMode}, AllowedKeys=${allowed.size}, DeepMode=${Boolean(
        meta?.deepMode
      )}`,
    };
  }

  return { patches: validPatches, rejectReason: "" };
}

/**
 * Request patch with retry logic
 */
async function getPatchWithRetry(errors, files, projectContext, strategy, meta, config) {
  let lastRejectReason = "";

  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
    const raw = await requestPatch(
      errors,
      files,
      projectContext,
      strategy,
      { ...meta, attempt, lastRejectReason },
      config
    );

    if (!raw) {
      lastRejectReason = "LLM request failed";
      continue;
    }

    const { patches, rejectReason } = parsePatchResponse(raw, files, meta, config);

    if (patches) {
      console.log(`✅ Valid patches received (${Object.keys(patches).length} files)`);
      return { patches, rejectReason: "" };
    }

    console.log(`⚠️ Invalid response (attempt ${attempt}/${config.maxRetries + 1}): ${rejectReason}`);
    lastRejectReason = rejectReason;
  }

  return { patches: null, rejectReason: lastRejectReason };
}

/* ================================================== */
/* ============== WRITE PATCHES ==================== */
/* ================================================== */

/**
 * Write patches to disk
 */
function writePatches(patches, workspace, config) {
  if (!patches || typeof patches !== "object") return [];

const written = [];

for (const [rel, content] of Object.entries(patches)) {

const abs = path.join(workspace, rel);

// Safety check

if (!fs.existsSync(path.dirname(abs))) {

ensureDir(path.dirname(abs));

}

// Hash check

const currentHash = fs.existsSync(abs) ? sha256(fs.readFileSync(abs,"utf8")) : "";

const newHash = sha256(content);

if (currentHash === newHash) {

console.log("ℹ️ Skipping (no change): ${rel}");

continue;

}

fs.writeFileSync(abs, content, "utf8");

written.push(rel);

console.log("💾 Applied patch to: ${rel}");

}

return written;

}

/* ================================================== */

/* =================== ENTRY POINT ================== */

/* ================================================== */

export async function runFixAgent(options = {}) {

const config = { ...DEFAULT_CONFIG, ...options };

const workspace = path.resolve(config.workspace);

console.log("🚀 Starting fix_agent in: ${workspace}");

const context = buildProjectContext(workspace, config);

let loopIndex = 0;

let diagnosticMode = false;

let history = []; // To prevent loops

while (loopIndex < config.maxLoops) {

loopIndex++;

console.log(`\n--- LOOP ${loopIndex}/${config.maxLoops} ---`);

// 1. Run build/test

const result = await run("npm run build", workspace); 

if (result.ok) {

console.log("✅ Build/Test passed!");

if (config.onSuccess) config.onSuccess();

return { success: true };

}

console.log("❌ Build failed, analyzing errors...");

// 2. Classify errors

const classification = classifyErrors(result.stderr || result.stdout);

const strategy = buildStrategyHints(classification);

// 3. Smart file selection

const rawFiles = parseErrorFiles(result.stderr || result.stdout, config.maxFiles);

const allFiles = diagnosticMode ? addNeighborFiles(rawFiles, workspace, config) : rawFiles;

// Limit file count again

const finalFiles = allFiles.slice(0, diagnosticMode ? config.maxFilesDeep : config.maxFiles);

// 4. Check for missing files

const missing = findMissingFiles(finalFiles, workspace);

if (missing.length > 0 && config.autoGenerateMissing) {

// Simple logic for auto-creating

  for (const m of missing) {
    console.log(`⚠️ Missing file detected: ${m}. Creating stub...`);
    ensureDirForFile(path.join(workspace, m));
    fs.writeFileSync(path.join(workspace, m), "// Auto-generated by fix_agent\nexport {};", "utf8");
  }
}

}

// 5. Build context

const fileContents = readFiles(finalFiles, workspace, config, diagnosticMode);

// 6. Loop protection (using hash of file states)

const stateHash = sha256(JSON.stringify(fileContents));

if (history.includes(stateHash)) {

console.log("⚠️ Stuck in a loop. Entering Diagnostic Mode.");

diagnosticMode = true;

}

history.push(stateHash);

// 7. Request patch

const { patches, rejectReason } = await getPatchWithRetry(

result.stderr || result.stdout,

fileContents,

context,

strategy,

{ loopIndex, diagnosticMode },

config

);

if (!patches) {

console.log(`🚫 Could not get valid patch: ${rejectReason}`);

if (diagnosticMode) {

console.log("🚨 Diagnostic mode failed. Manual intervention required.");

writeDiagFile(config, `error_state_${nowStamp()}.json`, JSON.stringify({
  output: result.stderr,
  context,
  finalFiles,
  strategy
}, null, 2));


return { success: false, reason: "Diagnostic failure" };

}

diagnosticMode = true;
return;

}

// 8. Write patches

const updated = writePatches(patches, workspace, config);

if (updated.length === 0) {
  console.log("ℹ️ No meaningful changes made.");
  diagnosticMode = true;
}
// حذف این } اضافی که اینجا بوده

return { success: false, reason: "Max loops reached" };
}
