import "dotenv/config";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { exec } from "child_process";
import { promisify } from "util";
import OpenAI from "openai";

import { generateMissingFiles } from "./missing_file_generator.mjs";
import { buildProjectContext } from "./project_context.mjs";
import { guardDependencies } from "./dependency_guard.mjs";
import { classifyErrors } from "./error_classifier.mjs";

const execAsync = promisify(exec);

/* ------------------------------------------------ */
/* CONFIG                                            */
/* ------------------------------------------------ */

const PROJECT_DIR = path.resolve(process.env.PROJECT_DIR || "backend");

const MAX_LOOPS = Number(process.env.MAX_LOOPS || 6);
const MAX_ERROR_CHARS = Number(process.env.MAX_ERROR_CHARS || 15000);
const MAX_CONTEXT_CHARS = Number(process.env.MAX_CONTEXT_CHARS || 25000);

const MAX_FILES = Number(process.env.MAX_FILES || 6);
const MAX_FILES_DEEP = Number(process.env.MAX_FILES_DEEP || 12);

const FILE_HEAD_LINES = Number(process.env.FILE_HEAD_LINES || 120);
const FILE_TAIL_LINES = Number(process.env.FILE_TAIL_LINES || 80);
const FILE_HEAD_LINES_DEEP = Number(process.env.FILE_HEAD_LINES_DEEP || 220);
const FILE_TAIL_LINES_DEEP = Number(process.env.FILE_TAIL_LINES_DEEP || 160);

// Full-file behavior in deep mode
const DEEP_SEND_FULL_FILES =
  String(process.env.DEEP_SEND_FULL_FILES || "true").toLowerCase() === "true";
const MAX_FULL_FILE_CHARS = Number(process.env.MAX_FULL_FILE_CHARS || 35000);

// Logging
const DEBUG_LLM = String(process.env.DEBUG_LLM || "true").toLowerCase() === "true";
const DEBUG_DIAG = String(process.env.DEBUG_DIAG || "true").toLowerCase() === "true";

const MODEL = process.env.MODEL || "gpt-4o-mini";
const DRY_RUN = String(process.env.DRY_RUN || "").toLowerCase() === "true";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  throw new Error(
    "Missing OPENAI_API_KEY. Put it in your environment (or .env) before running fix_agent."
  );
}

const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || "https://api.gapgpt.app/v1",
});

/* ------------------------------------------------ */
/* HELPERS                                           */
/* ------------------------------------------------ */

function sha256(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function truncate(text, maxChars) {
  if (!text) return "";
  const s = String(text);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + "\n\n... <truncated> ...\n";
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

function writeDebugFile(rel, content) {
  try {
    const abs = path.join(PROJECT_DIR, ".fix_agent", rel);
    ensureDirForFile(abs);
    fs.writeFileSync(abs, String(content || ""), "utf8");
  } catch {
    // ignore
  }
}

function writeDiagFile(rel, content) {
  try {
    const abs = path.join(PROJECT_DIR, ".fix_agent", "diagnostics", rel);
    ensureDirForFile(abs);
    fs.writeFileSync(abs, String(content || ""), "utf8");
  } catch {
    // ignore
  }
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(
    d.getHours()
  )}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/**
 * Extract the first valid JSON object from arbitrary text.
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

// Relaxed validation option for deep mode
function isCodeLike(content) {
  if (typeof content !== "string") return false;
  const s = content.trim();
  if (s.length < 30) return false;

  // Reject obvious explanations/markdown/json
  const badStarts = ["Here is", "Sure,", "I will", "Explanation:", "```", "{", "["];
  if (badStarts.some((b) => s.startsWith(b))) return false;

  return (
/(^|\n)\s*(import|export|type|interface|const|let|class|function)\b/.test(s) ||
/(^|\n)\s*(\/\/|\/\*)/.test(s) ||
/(^|\n)\s*([a-zA-Z0-9_$]+\s*[:=]\s*)/.test(s)
  );
}

function isProbablyFullFile(content) {
  if (typeof content !== "string") return false;
  const s = content.trim();
  if (s.length < 120) return false;

  const badStarts = ["Here is", "Sure,", "I will", "Explanation:", "```", "{", "["];
  if (badStarts.some((b) => s.startsWith(b))) return false;

  const looksTS =
    /(^|\n)\s*(import|export|type|interface|const|let|class|function)\b/.test(s) ||
    /(^|\n)\s*(\/\/|\/\*)/.test(s);

  return looksTS;
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

/* ------------------------------------------------ */
/* RUNNER                                            */
/* ------------------------------------------------ */

async function run(cmd, cwd = PROJECT_DIR) {
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
    };
  }
}

/* ------------------------------------------------ */
/* PACKAGE MANAGER                                   */
/* ------------------------------------------------ */

function detectPkgManager() {
  if (fs.existsSync(path.join(PROJECT_DIR, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(PROJECT_DIR, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(PROJECT_DIR, "package-lock.json"))) return "npm";
  return "npm";
}

function installCommand(pkgs, { dev = false } = {}) {
  const pm = detectPkgManager();
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

/* ------------------------------------------------ */
/* INSTALL MISSING MODULES                           */
/* ------------------------------------------------ */

async function installMissingModules(output) {
  const regex = /Cannot find module ['"](.+?)['"]/g;
  const modules = new Set();
  let match;

  while ((match = regex.exec(output || ""))) {
    const mod = match[1];
    if (!mod.startsWith(".")) modules.add(mod);
  }

  if (!modules.size) return false;

  const list = [...modules];
  console.log("\n📦 Installing missing runtime modules:", list);

  if (DRY_RUN) {
    console.log("🧪 DRY_RUN=true -> skipping install");
    return true;
  }

  await run(installCommand(list, { dev: false }));
  return true;
}

/* ------------------------------------------------ */
/* INSTALL MISSING TYPES + SHIMS                      */
/* ------------------------------------------------ */

function mapModuleToTypesPackage(modName) {
  if (modName.startsWith("@")) {
    return `@types/${modName.slice(1).replace("/", "__")}`;
  }
  return `@types/${modName}`;
}

function findMissingDeclarationModules(output) {
  const regex = /Could not find a declaration file for module ['"](.+?)['"]/g;
  const modules = new Set();
  let match;
  while ((match = regex.exec(output || ""))) {
    const mod = match[1];
    if (!mod.startsWith(".")) modules.add(mod);
  }
  return [...modules];
}

function createTypeShim(modName) {
  return `// Auto-generated by fix_agent.mjs to unblock TypeScript compilation.
declare module "${modName}" {
  const anyExport: any;
  export = anyExport;
}
`;
}

async function installMissingTypes(output) {
  const missing = findMissingDeclarationModules(output);
  if (!missing.length) return { didSomething: false, installed: [], shimmed: [] };

  console.log("\n🧩 Missing type declarations for modules:", missing);

  const typePkgs = [...new Set(missing.map(mapModuleToTypesPackage))];
  console.log("📦 Attempting to install type packages:", typePkgs);

  if (!DRY_RUN) {
    await run(installCommand(typePkgs, { dev: true }));
  } else {
    console.log("🧪 DRY_RUN=true -> skipping @types install");
  }

  const tsc2 = await run("npx tsc --noEmit --pretty false");
  const out2 = (tsc2.stdout || "") + "\n" + (tsc2.stderr || "");
  const stillMissing = findMissingDeclarationModules(out2);

  const shimmed = [];
  if (stillMissing.length) {
    console.log("\n🧷 Still missing declarations after @types install:", stillMissing);
    console.log("🧷 Creating/Updating src/types/vendor.d.ts");

    const shimFileAbs = path.join(PROJECT_DIR, "src/types/vendor.d.ts");

    if (!DRY_RUN) {
      ensureDirForFile(shimFileAbs);
      const existing = readTextIfExists(shimFileAbs) || "";
      let appended = "";

      for (const mod of stillMissing) {
        if (existing.includes(`declare module "${mod}"`)) continue;
        appended += "\n" + createTypeShim(mod);
        shimmed.push(mod);
      }

      if (appended.trim().length) {
        fs.writeFileSync(shimFileAbs, (existing + "\n" + appended).trimStart(), "utf8");
      }
    } else {
      shimmed.push(...stillMissing);
      console.log("🧪 DRY_RUN=true -> skipping shim file write");
    }
  }

  return { didSomething: true, installed: typePkgs, shimmed };
}

/* ------------------------------------------------ */
/* ERROR PARSING                                     */
/* ------------------------------------------------ */

/**
 * Extract file paths from tsc output robustly.
 * Supports formats like:
 * - src/foo.ts(12,5): error TS...
 * - src/foo.ts:12:5 - error TS...
 * - packages/x/src/foo.ts(1,1): error TS...
 */
function parseTscFiles(output, limit) {
  const lines = String(output || "").split("\n");
  const files = new Set();

  // Common path-ish matcher ending with ts/tsx/mts/cts/js/mjs/d.ts
  const rx = /([a-zA-Z0-9_@./\\-]+?\.(?:d\.ts|ts|tsx|mts|cts|js|mjs))(?=[(:\s])/g;

  for (const line of lines) {
    let m;
    while ((m = rx.exec(line))) {
      const raw = m[1].replaceAll("\\", "/");
      // Ignore node_modules to avoid noise
      if (raw.includes("node_modules/")) continue;
      // Prefer project-relative paths (strip leading ./)
      const normalized = raw.startsWith("./") ? raw.slice(2) : raw;
      files.add(normalized);
    }
  }

  return [...files].slice(0, limit);
}

// Expand file list with neighbor files to improve context
function addNeighborFiles(files) {
  const set = new Set(files || []);
  const candidates = [
    "src/auth/utils.ts",
    "src/auth/utils.js",
    "src/auth/jwt-middleware.ts",
    "src/routes/auth.ts",
    "src/db/schema.ts",
    "src/types/fastify.d.ts",
    "src/types/vendor.d.ts",
  ];
  for (const f of candidates) set.add(f);
  return [...set];
}

function readFiles(files, { headLines, tailLines, deepMode }) {
  const result = {};

  for (const file of files) {
    const abs = path.join(PROJECT_DIR, file);
    if (!fs.existsSync(abs)) continue;

    const content = fs.readFileSync(abs, "utf8");

    if (deepMode && DEEP_SEND_FULL_FILES) {
      result[file] = truncate(content, MAX_FULL_FILE_CHARS);
      continue;
    }

    const lines = content.split("\n");
    const head = lines.slice(0, headLines).join("\n");
    const tail = lines.slice(-tailLines).join("\n");

    result[file] = `${head}\n\n// ... truncated ...\n\n${tail}`;
  }

  return result;
}

function filterTscToRelevantLines(output) {
  const lines = String(output || "").split("\n");
  const keep = [];
  for (const line of lines) {
    if (/error TS\d+:/i.test(line)) keep.push(line);
    if (/\bTS\d+\b/i.test(line)) keep.push(line);
  }
  return keep.join("\n");
}

function listAllProjectFiles({ max = 5000 } = {}) {
  const out = [];
  const root = PROJECT_DIR;

  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(root, abs).replaceAll("\\", "/");

      if (rel.startsWith("node_modules/") || rel.startsWith(".git/") || rel.startsWith(".fix_agent/"))
        continue;

      if (ent.isDirectory()) {
        walk(abs);
      } else {
        out.push(rel);
        if (out.length >= max) return;
      }
    }
  };

  walk(root);
  return out;
}

/**
 * وجود فایل با درنظر گرفتن fallback برای import های .js که منبع .ts دارند
 */
function fileExistsWithTsFallback(relPath) {
  const abs = path.join(PROJECT_DIR, relPath);
  if (fs.existsSync(abs)) return true;

  if (relPath.endsWith(".js")) {
    const base = relPath.slice(0, -3);
    const tsAbs = path.join(PROJECT_DIR, base + ".ts");
    const noExtAbs = path.join(PROJECT_DIR, base);
    if (fs.existsSync(tsAbs) || fs.existsSync(noExtAbs)) {
      return true;
    }
  }

  return false;
}

function missingFilesFromList(files) {
  const missing = [];
  for (const f of files || []) {
    if (!fileExistsWithTsFallback(f)) {
      missing.push(f);
    }
  }
  return missing;
}

/* ------------------------------------------------ */
/* LLM PATCH                                         */
/* ------------------------------------------------ */

function buildStrategyHints(classification) {
  const hints = [];

  const all = JSON.stringify(classification || {});

  if (all.includes("autoincrement")) {
    hints.push(
      "- Drizzle SQLite: if `autoincrement()` is not available, replace with the correct sqlite-core schema pattern for your drizzle-orm version (often integer primary key without calling autoincrement(), or using `primaryKey({ autoIncrement: true })` depending on version)."
    );
  }
  if (all.includes("request.user")) {
    hints.push(
      "- Fastify request.user typing: ensure request decoration exists and add TS module augmentation for FastifyRequest.user (or avoid request.user if you store it elsewhere)."
    );
  }
  if (all.includes("verifyToken")) {
    hints.push(
      "- Export mismatch: ensure utils exports `verifyToken` (named export) OR change import to match existing export. Keep ESM import paths consistent (.js vs .ts in TS source)."
    );
  }
  if (all.includes("bcrypt")) {
    hints.push(
      "- bcrypt overload errors often come from wrong import style (default vs namespace) or mixing callbacks/promises. Make imports consistent with installed bcrypt + @types."
    );
  }
  if (all.includes("TS2835")) {
    hints.push(
      "- TS2835 (ESM import extensions): For NodeNext/Node16 moduleResolution, fix relative imports to use explicit .js extensions at runtime, but ensure the corresponding .ts source exists. If a .js import points to a .ts file, either: (a) create a small JS shim that re-exports from the TS file, or (b) adjust tsconfig/module settings consistently."
    );
  }
  if (all.includes("TS2345")) {
    hints.push(
      "- TS2345 on schema defaults: Ensure default values for columns match their declared types. For timestamp/date columns use Date or SQL expressions (e.g., CURRENT_TIMESTAMP) instead of raw numbers. For integer columns, avoid passing Date objects."
    );
  }
  if (all.includes("Property 'name' does not exist")) {
    hints.push(
      "- Property 'name' missing on User: either add a `name` column to the user schema (and update types) or stop using `user.name` in services/routes. Keep schema and returned DTOs consistent."
    );
  }

  return hints.length ? hints.join("\n") : "- Fix the root causes, not just types.";
}

function normalizeKeyToAllowed(k, allowedSet) {
  if (allowedSet.has(k)) return k;

  // try swapping .ts <-> .js
  if (k.endsWith(".js")) {
    const k2 = k.slice(0, -3) + ".ts";
    if (allowedSet.has(k2)) return k2;
  }
  if (k.endsWith(".ts")) {
    const k2 = k.slice(0, -3) + ".js";
    if (allowedSet.has(k2)) return k2;
  }

  // try removing leading ./
  if (k.startsWith("./")) {
    const k2 = k.slice(2);
    if (allowedSet.has(k2)) return k2;
  }

  return null;
}

async function batchFix(
  errors,
  files,
  projectContext,
  meta = {},
  classification = {},
  attempt = 1,
  lastRejectReason = ""
) {
  console.log("🧠 Sending batch fix request...\n");

  const strategy = buildStrategyHints(classification);

  const prompt = [
    "You are a senior TypeScript backend engineer. Fix compilation errors by editing code.",
    "",
    "CRITICAL RULES:",
    "- Return ONLY valid JSON (no markdown, no explanations, no extra keys)",
    "- Keys MUST be existing file paths from the provided FILES object (subset allowed)",
    "- Values MUST be FULL file contents (complete replacement)",
    "- Do NOT append. Replace entire file.",
    "- Do not change unrelated formatting; keep minimal diffs.",
    "- Ensure changes are consistent across imports/types/tests.",
    "",
    attempt > 1 ? "IMPORTANT: Your previous response was rejected by the validator." : "",
    attempt > 1 ? `REJECTION REASON: ${lastRejectReason || "(unknown)"}` : "",
    "",
    "STRATEGY (IMPORTANT):",
    strategy,
    "",
    "META:",
    safeJson(meta),
    "",
    "PROJECT CONTEXT:",
    projectContext,
    "",
    "TYPESCRIPT ERRORS (filtered):",
    filterTscToRelevantLines(errors),
    "",
    "FILES (may include full files in DEEP mode):",
    safeJson(files),
    "",
    "Output format:",
    '{ "src/file.ts": "full corrected file content" }',
  ]
    .filter(Boolean)
    .join("\n");

  const resp = await client.chat.completions.create({
    model: MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: "You fix backend TypeScript projects." },
      { role: "user", content: prompt },
    ],
  });

  const raw0 = resp.choices?.[0]?.message?.content || "";
  if (DEBUG_LLM) writeDebugFile("last_llm_response.txt", raw0);

  const raw = clean(raw0);

  let parsed = null;
  let parseMode = "direct";
  try {
    parsed = JSON.parse(raw);
  } catch {
    const extracted = extractJSON(raw);
    if (!extracted) {
      if (DEBUG_LLM)
        console.log("⚠️ No JSON found in model response. First 1200 chars:\n", raw0.slice(0, 1200));
      return { patches: null, rejectReason: "No JSON found in model response (maybe markdown/explanation)." };
    }
    try {
      parsed = JSON.parse(extracted);
      parseMode = "extracted";
    } catch {
      if (DEBUG_LLM)
        console.log("⚠️ JSON parsing failed. First 1200 chars:\n", raw0.slice(0, 1200));
      return { patches: null, rejectReason: "JSON parsing failed even after extraction." };
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { patches: null, rejectReason: "Model JSON is not an object." };
  }

  const allowed = new Set(Object.keys(files || {}));
  const out = {};

  for (const [kRaw, v] of Object.entries(parsed)) {
    const k = normalizeKeyToAllowed(String(kRaw), allowed);
    if (!k) continue;

    const deepMode = Boolean(meta?.deepMode);
    const ok = deepMode ? isProbablyFullFile(v) || isCodeLike(v) : isProbablyFullFile(v);
    if (!ok) continue;

    out[k] = v;
  }

  if (!Object.keys(out).length) {
    const reason = `No valid file patches after validation. parseMode=${parseMode}. AllowedKeys=${
      allowed.size
    }. DeepMode=${Boolean(meta?.deepMode)}. Validator=${
      Boolean(meta?.deepMode) ? "full||codelike" : "fullOnly"
    }.`;
    if (DEBUG_LLM) {
      console.log("⚠️ " + reason);
      console.log("First 1200 chars of raw model output:\n", raw0.slice(0, 1200));
    }
    return { patches: null, rejectReason: reason };
  }

  return { patches: out, rejectReason: "" };
}

/* ------------------------------------------------ */
/* WRITE FILES                                       */
/* ------------------------------------------------ */

function writeFiles(patches) {
  if (!patches || typeof patches !== "object") {
    console.log("⚠️ No valid patches returned.");
    return { wrote: 0, changed: 0, patchHash: sha256("") };
  }

  let wrote = 0;
  let changed = 0;

  // Stable hash of patch intent (keys + file hashes) to detect “same patch again”
  const patchMeta = [];

  for (const file of Object.keys(patches).sort()) {
    const newContent = patches[file];
    if (!newContent) continue;

    const abs = path.join(PROJECT_DIR, file);
    ensureDirForFile(abs);

    const oldContent = readTextIfExists(abs) ?? "";
    const oldHash = sha256(oldContent);
    const newHash = sha256(newContent);

    patchMeta.push({ file, oldHash, newHash, len: String(newContent).length });

    if (oldHash === newHash) {
      console.log(`↩️ unchanged (skip write): ${file}`);
      continue;
    }

    changed++;

    if (DRY_RUN) {
      console.log(`🧪 DRY_RUN would write: ${file} (len=${String(newContent).length})`);
      continue;
    }

    fs.writeFileSync(abs, newContent, "utf8");
    console.log("✅ fixed", file);
    wrote++;
  }

  const patchHash = sha256(JSON.stringify(patchMeta));
  return { wrote, changed, patchHash };
}

/* ------------------------------------------------ */
/* DIAGNOSTICS / EXIT HANDLING                       */
/* ------------------------------------------------ */

async function enterDiagnosticMode({
  reason,
  loopIndex,
  tscOutputRaw,
  tscFiltered,
  fileList,
  missingFiles,
  lastPatchHash,
}) {
  const stamp = nowStamp();
  const header = [
    `reason=${reason}`,
    `loopIndex=${loopIndex}`,
    `projectDir=${PROJECT_DIR}`,
    `model=${MODEL}`,
    `dryRun=${DRY_RUN}`,
    `lastPatchHash=${lastPatchHash || ""}`,
    "",
  ].join("\n");

  console.log("\n🧯 Entering DIAGNOSTIC MODE");
  console.log(header);

  if (!DEBUG_DIAG) {
    console.log("ℹ️ DEBUG_DIAG=false, not writing diagnostic files.");
    console.log("🛑 Stopping (needs human/context).");
    return;
  }

  writeDiagFile(`${stamp}/_header.txt`, header);
  writeDiagFile(`${stamp}/tsc_raw.txt`, tscOutputRaw || "");
  writeDiagFile(`${stamp}/tsc_filtered.txt`, tscFiltered || "");
  writeDiagFile(`${stamp}/missing_files_from_tsc.txt`, (missingFiles || []).join("\n"));
  writeDiagFile(`${stamp}/tsc_files.txt`, (fileList || []).join("\n"));

  // Environment + dependency snapshot
  const versions = await run('node -p "process.versions"');
  writeDiagFile(`${stamp}/node_versions.txt`, (versions.stdout || "") + "\n" + (versions.stderr || ""));

  const pm = detectPkgManager();
  const listCmd =
    pm === "pnpm"
      ? "pnpm ls --depth=0"
      : pm === "yarn"
      ? "yarn list --depth=0"
      : "npm ls --depth=0";
  const deps = await run(listCmd);
  writeDiagFile(`${stamp}/deps_tree.txt`, (deps.stdout || "") + "\n" + (deps.stderr || ""));

  // tsconfig snapshot
  const tsconfigAbs = path.join(PROJECT_DIR, "tsconfig.json");
  const tsconfig = readTextIfExists(tsconfigAbs);
  if (tsconfig) writeDiagFile(`${stamp}/tsconfig.json`, tsconfig);

  // Project file listing (limited)
  const listing = listAllProjectFiles({ max: 8000 });
  writeDiagFile(`${stamp}/project_file_list.txt`, listing.join("\n"));

  console.log(
    `\n📦 Diagnostic bundle written to: ${path.join(
      PROJECT_DIR,
      ".fix_agent",
      "diagnostics",
      stamp
    )}`
  );
  console.log("\n🛑 Stopping to avoid infinite loop. Next steps:");
  if ((missingFiles || []).length) {
    console.log(
      "- tsc references files that do not exist on disk. Check wrong tsconfig, build output paths, or running tsc in wrong directory."
    );
    console.log("- Fix the path issue first; then rerun fix_agent.");
  } else {
    console.log(
      "- Attach/share the diagnostic bundle folder or paste tsc_raw + the referenced source files so we can fix deterministically."
    );
  }
}

/* ------------------------------------------------ */
/* MAIN                                              */
/* ------------------------------------------------ */

async function main() {
  console.log("⚙️ Repo‑Aware Fix Agent Starting\n");
  console.log(`📁 PROJECT_DIR: ${PROJECT_DIR}`);
  console.log(`🧪 DRY_RUN: ${DRY_RUN ? "true" : "false"}`);
  console.log(`🧠 MODEL: ${MODEL}`);
  console.log(`🧠 DEBUG_LLM: ${DEBUG_LLM ? "true" : "false"}`);
  console.log(`🧠 DEBUG_DIAG: ${DEBUG_DIAG ? "true" : "false"}`);
  console.log(`🧠 DEEP_SEND_FULL_FILES: ${DEEP_SEND_FULL_FILES ? "true" : "false"}`);

  guardDependencies(PROJECT_DIR);

  await run(installCommand([], { dev: false }));

  let lastTscHash = "";
  let sameErrorCount = 0;

  let lastPatchHash = "";
  let samePatchCount = 0;

  let noWriteStreak = 0;

  for (let i = 0; i < MAX_LOOPS; i++) {
    const loopIndex = i + 1;

    console.log(`\n🔍 TypeScript check (loop ${loopIndex}/${MAX_LOOPS})`);

    const tsc = await run("npx tsc --noEmit --pretty false");
    if (tsc.ok) {
      console.log("\n✅ Project compiles successfully");
      return;
    }

    const tscOutputRawFull = (tsc.stdout || "") + "\n" + (tsc.stderr || "");
    let output = truncate(tscOutputRawFull, MAX_ERROR_CHARS);

    const classification = classifyErrors(output);

    const filtered = filterTscToRelevantLines(output);
    const thisHash = sha256(filtered);

    if (thisHash === lastTscHash) {
      sameErrorCount++;
      console.log(
        `\n⚠️ Same tsc (filtered) hash again (${thisHash.slice(0, 10)}...), count=${sameErrorCount}`
      );
    } else {
      sameErrorCount = 0;
    }
    lastTscHash = thisHash;

    // Escalate only after true repetition
    const deepMode = sameErrorCount >= 1;
    console.log(`\n🧠 Mode: ${deepMode ? "DEEP" : "NORMAL"}`);

    console.log("\n📊 Error classification:");
    console.log(JSON.stringify(classification, null, 2));

    // Dependency/type self-healing
    const didInstallModules = await installMissingModules(output);
    const typesRes = await installMissingTypes(output);

    if (didInstallModules || typesRes.didSomething) {
      console.log("\n🔁 Re-checking tsc after installs...");
      const tscAfter = await run("npx tsc --noEmit --pretty false");
      if (tscAfter.ok) {
        console.log("\n✅ Project compiles successfully (after dependency/type fixes)");
        return;
      }
      const afterRaw = (tscAfter.stdout || "") + "\n" + (tscAfter.stderr || "");
      output = truncate(afterRaw, MAX_ERROR_CHARS);
    }

    let projectContext = buildProjectContext(PROJECT_DIR);
    projectContext = truncate(projectContext, MAX_CONTEXT_CHARS);

    await generateMissingFiles(PROJECT_DIR, output, projectContext);

    // Determine target files from tsc output
    const fileLimit = deepMode ? MAX_FILES_DEEP : MAX_FILES;
    let files = parseTscFiles(output, fileLimit);

    files = deepMode ? addNeighborFiles(files).slice(0, MAX_FILES_DEEP) : files;

    // Hard guard: if tsc points to files that do not exist, stop + diagnostics
    const missing = missingFilesFromList(files);
    if (missing.length) {
      await enterDiagnosticMode({
        reason: "TSC_REFERENCES_MISSING_FILES",
        loopIndex,
        tscOutputRaw: tscOutputRawFull,
        tscFiltered: filterTscToRelevantLines(tscOutputRawFull),
        fileList: files,
        missingFiles: missing,
        lastPatchHash,
      });
      return;
    }

    if (!files.length) {
      await enterDiagnosticMode({
        reason: "NO_FILES_DETECTED_FROM_TSC",
        loopIndex,
        tscOutputRaw: tscOutputRawFull,
        tscFiltered: filterTscToRelevantLines(tscOutputRawFull),
        fileList: [],
        missingFiles: [],
        lastPatchHash,
      });
      return;
    }

    console.log("\n📂 Files with errors:", files);

    const contents = readFiles(files, {
      headLines: deepMode ? FILE_HEAD_LINES_DEEP : FILE_HEAD_LINES,
      tailLines: deepMode ? FILE_TAIL_LINES_DEEP : FILE_TAIL_LINES,
      deepMode,
    });

    // 1) Ask LLM for patch
    let { patches, rejectReason } = await batchFix(
      output,
      contents,
      projectContext,
      { loopIndex, maxLoops: MAX_LOOPS, deepMode, tscHash: thisHash, sameErrorCount },
      classification,
      1,
      ""
    );

    // Retry once if invalid
    if (!patches) {
      console.log("⚠️ Skipping write due to invalid model response.");
      console.log("🔁 Retrying once with stricter instructions...");
      const retry = await batchFix(
        output,
        contents,
        projectContext,
        { loopIndex, maxLoops: MAX_LOOPS, deepMode, tscHash: thisHash, sameErrorCount },
        classification,
        2,
        rejectReason
      );
      patches = retry.patches;
      rejectReason = retry.rejectReason;
    }

    if (!patches) {
      console.log("⚠️ Still no valid patches after retry.");

      // If repeatedly stuck with invalid patches, stop with diagnostics
      if (sameErrorCount >= 2) {
        await enterDiagnosticMode({
          reason: "REPEATED_INVALID_PATCHES",
          loopIndex,
          tscOutputRaw: tscOutputRawFull,
          tscFiltered: filterTscToRelevantLines(tscOutputRawFull),
          fileList: files,
          missingFiles: [],
          lastPatchHash,
        });
        return;
      }

      continue;
    }

    // 2) Apply patches
    const { wrote, changed, patchHash } = writeFiles(patches);

    if (changed === 0) {
      noWriteStreak++;
      console.log(`\n⚠️ No actual changes written this loop. noWriteStreak=${noWriteStreak}`);
    } else {
      noWriteStreak = 0;
    }

    if (patchHash && lastPatchHash && patchHash === lastPatchHash) {
      samePatchCount++;
      console.log(
        `\n⚠️ Patch hash unchanged across loops (${patchHash.slice(
          0,
          10
        )}...), count=${samePatchCount}`
      );
    } else {
      samePatchCount = 0;
    }
    // بعد از مقایسه، مقدار جدید را ذخیره می‌کنیم
    lastPatchHash = patchHash;

    // Emergency exit: stuck patch loop
    if (samePatchCount >= 2 || noWriteStreak >= 3) {
      await enterDiagnosticMode({
        reason: "PATCH_LOOP_STUCK",
        loopIndex,
        tscOutputRaw: tscOutputRawFull,
        tscFiltered: filterTscToRelevantLines(tscOutputRawFull),
        fileList: files,
        missingFiles: [],
        lastPatchHash,
      });
      return;
    }
  }

  // If we reached here, max loops hit without success
  console.log("\n⏹️ Max loops reached — errors may remain.");
}

// top-level runner with error logging
main().catch((err) => {
  console.error("💥 Unhandled error in fix_agent:", err);
  process.exitCode = 1;
});
