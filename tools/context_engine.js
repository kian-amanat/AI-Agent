import path from "path";
import fs from "fs/promises";

import { listBackendFiles } from "./list_backend_files.js";
import { readProjectFile } from "./readProjectFile.js";

const PROJECT_ROOT = process.cwd();

const IMPORT_REGEX =
  /import\s+(?:.+?\s+from\s+)?["'](.+?)["']/g;

const REQUIRE_REGEX =
  /require\(["'](.+?)["']\)/g;

const SUPPORTED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
]);

/* -------------------------------------------------- */
/* ---------------- BASIC HELPERS ------------------- */
/* -------------------------------------------------- */

function normalize(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .trim();
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function safeJson(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return "";
  }
}

function looksLikeCodeFile(file) {
  return SUPPORTED_EXTENSIONS.some((ext) =>
    file.endsWith(ext)
  );
}

/* -------------------------------------------------- */
/* ---------------- FILE DISCOVERY ------------------ */
/* -------------------------------------------------- */

async function getAllProjectFiles() {
  const result = await listBackendFiles({
    dir: "",
    maxDepth: 12,
    includeMeta: false,
  });

  if (!result.success) {
    return [];
  }

  return result.files
    .filter((f) => !f.is_dir)
    .map((f) => normalize(f.path))
    .filter(looksLikeCodeFile);
}

/* -------------------------------------------------- */
/* ---------------- IMPORT PARSING ------------------ */
/* -------------------------------------------------- */

function extractImports(content) {
  const imports = [];

  let match;

  while ((match = IMPORT_REGEX.exec(content))) {
    imports.push(match[1]);
  }

  while ((match = REQUIRE_REGEX.exec(content))) {
    imports.push(match[1]);
  }

  return uniq(imports);
}

/* -------------------------------------------------- */
/* ---------------- RESOLVE IMPORTS ----------------- */
/* -------------------------------------------------- */

function resolveImport(fromFile, importPath) {
  if (!importPath.startsWith(".")) {
    return null;
  }

  const baseDir = path.dirname(fromFile);

  for (const ext of SUPPORTED_EXTENSIONS) {
    const full = normalize(
      path.join(baseDir, importPath + ext)
    );

    const abs = path.join(PROJECT_ROOT, full);

    try {
      if (require("fs").existsSync(abs)) {
        return full;
      }
    } catch {}
  }

  for (const ext of SUPPORTED_EXTENSIONS) {
    const full = normalize(
      path.join(baseDir, importPath, "index" + ext)
    );

    const abs = path.join(PROJECT_ROOT, full);

    try {
      if (require("fs").existsSync(abs)) {
        return full;
      }
    } catch {}
  }

  return null;
}

/* -------------------------------------------------- */
/* ---------------- KEYWORD SCORING ----------------- */
/* -------------------------------------------------- */

function scoreFile(filePath, userMessage) {
  const msg = userMessage.toLowerCase();

  let score = 0;

  const tokens = normalize(filePath)
    .split("/")
    .join(" ")
    .split(/[\s\-_]+/);

  for (const token of tokens) {
    if (!token) continue;

    if (msg.includes(token.toLowerCase())) {
      score += 5;
    }
  }

  if (msg.includes("page") && filePath.includes("page.")) {
    score += 10;
  }

  if (
    msg.includes("component") &&
    filePath.includes("components")
  ) {
    score += 8;
  }

  if (
    msg.includes("api") &&
    filePath.includes("api")
  ) {
    score += 8;
  }

  if (
    msg.includes("route") &&
    filePath.includes("routes")
  ) {
    score += 8;
  }

  return score;
}

/* -------------------------------------------------- */
/* ---------------- FILE RANKER --------------------- */
/* -------------------------------------------------- */

async function rankRelevantFiles(userMessage, limit = 8) {
  const allFiles = await getAllProjectFiles();

  const scored = allFiles
    .map((file) => ({
      file,
      score: scoreFile(file, userMessage),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map((x) => x.file);
}

/* -------------------------------------------------- */
/* ------------- IMPORT GRAPH WALKER ---------------- */
/* -------------------------------------------------- */

async function collectDependencyGraph(entryFiles, maxDepth = 3) {
  const visited = new Set();

  const graph = {};

  async function walk(file, depth) {
    if (depth > maxDepth) return;

    const normalized = normalize(file);

    if (visited.has(normalized)) {
      return;
    }

    visited.add(normalized);

    const res = await readProjectFile({
      path: normalized,
      maxBytes: 120000,
    });

    if (!res.success) {
      return;
    }

    const imports = extractImports(res.content);

    graph[normalized] = [];

    for (const imp of imports) {
      const resolved = resolveImport(normalized, imp);

      if (!resolved) continue;

      graph[normalized].push(resolved);

      await walk(resolved, depth + 1);
    }
  }

  for (const file of entryFiles) {
    await walk(file, 0);
  }

  return graph;
}

/* -------------------------------------------------- */
/* ---------------- CONTEXT CHUNKS ------------------ */
/* -------------------------------------------------- */

async function buildContextChunks(files) {
  const chunks = [];

  for (const file of files) {
    const res = await readProjectFile({
      path: file,
      maxBytes: 150000,
    });

    if (!res.success) continue;

    chunks.push({
      path: file,
      content: res.content.slice(0, 12000),
    });
  }

  return chunks;
}

/* -------------------------------------------------- */
/* ---------------- PUBLIC ENGINE ------------------- */
/* -------------------------------------------------- */

export async function buildSmartContext({
  userMessage,
  maxFiles = 12,
  dependencyDepth = 2,
} = {}) {
  const relevantFiles = await rankRelevantFiles(
    userMessage,
    maxFiles
  );

  const dependencyGraph = await collectDependencyGraph(
    relevantFiles,
    dependencyDepth
  );

  const dependencyFiles = uniq(
    Object.values(dependencyGraph).flat()
  );

  const finalFiles = uniq([
    ...relevantFiles,
    ...dependencyFiles,
  ]).slice(0, maxFiles);

  const chunks = await buildContextChunks(finalFiles);

  return {
    success: true,
    relevantFiles,
    dependencyGraph,
    files: finalFiles,
    chunks,
  };
}