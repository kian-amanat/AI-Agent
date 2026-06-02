import path from "path";
import fsSync from "fs";
import { promises as fs } from "fs";

import { listBackendFiles } from "./list_backend_files.js";
import { readProjectFile } from "./readProjectFile.js";

const PROJECT_ROOT = process.cwd();

const IMPORT_REGEX = /import\s+(?:.+?\s+from\s+)?["'](.+?)["']/g;
const REQUIRE_REGEX = /require\(["'](.+?)["']\)/g;

const SUPPORTED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".css",
  ".scss",
];

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".cache",
  "out",
]);

function normalize(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .trim();
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function looksLikeCodeFile(file) {
  return SUPPORTED_EXTENSIONS.some((ext) => file.endsWith(ext));
}

function extractImports(content) {
  const imports = [];
  let match;

  IMPORT_REGEX.lastIndex = 0;
  REQUIRE_REGEX.lastIndex = 0;

  while ((match = IMPORT_REGEX.exec(content))) {
    imports.push(match[1]);
  }

  while ((match = REQUIRE_REGEX.exec(content))) {
    imports.push(match[1]);
  }

  return uniq(imports);
}

function extractFilenameHints(userMessage) {
  const msg = String(userMessage || "");

  const pathRegex =
    /(?:\/?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.(?:tsx?|jsx?|css|scss|md|json|ya?ml|html|xml|mjs|cjs|ts|js))/g;

  const filenameRegex =
    /\b[A-Za-z0-9._-]+\.(?:tsx?|jsx?|css|scss|md|json|ya?ml|html|xml|mjs|cjs|ts|js)\b/g;

  const matches = uniq([
    ...(msg.match(pathRegex) || []),
    ...(msg.match(filenameRegex) || []),
  ]);

  return matches.map((m) => normalize(m));
}

async function getAllProjectFiles() {
  const result = await listBackendFiles({
    dir: "",
    maxDepth: 12,
    includeMeta: true,
    includeFiles: true,
    includeDirs: false,
  });

  if (!result?.success || !Array.isArray(result.files)) {
    return [];
  }

  return result.files
    .filter((f) => !f.is_dir)
    .map((f) => normalize(f.path))
    .filter(looksLikeCodeFile);
}

function scoreFile(filePath, userMessage) {
  const msg = normalize(String(userMessage || "").toLowerCase());

  let score = 0;

  const fileLower = normalize(filePath).toLowerCase();
  const baseName = path.basename(filePath).toLowerCase();

  if (msg.includes(baseName)) score += 80;

  const tokens = fileLower.split("/").join(" ").split(/[\s\-_]+/);

  for (const token of tokens) {
    if (!token) continue;
    if (msg.includes(token.toLowerCase())) {
      score += 5;
    }
  }

  if (msg.includes("page") && baseName.includes("page.")) {
    score += 20;
  }

  if (msg.includes("component") && fileLower.includes("components")) {
    score += 18;
  }

  if (msg.includes("login") && fileLower.includes("login")) {
    score += 20;
  }

  if (msg.includes("sidebar") && fileLower.includes("sidebar")) {
    score += 20;
  }

  if (msg.includes("chat") && fileLower.includes("chat")) {
    score += 15;
  }

  if (msg.includes("api") && fileLower.includes("api")) {
    score += 15;
  }

  if (msg.includes("route") && fileLower.includes("route")) {
    score += 15;
  }

  if (msg.includes("layout") && fileLower.includes("layout")) {
    score += 12;
  }

  return score;
}

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

function resolveImport(fromFile, importPath) {
  if (!importPath || !importPath.startsWith(".")) {
    return null;
  }

  const baseDir = path.dirname(fromFile);

  const candidates = [];

  const base = normalize(path.join(baseDir, importPath));
  candidates.push(base);

  for (const ext of SUPPORTED_EXTENSIONS) {
    candidates.push(base + ext);
  }

  for (const ext of SUPPORTED_EXTENSIONS) {
    candidates.push(path.join(base, "index" + ext));
  }

  for (const candidate of candidates) {
    const abs = path.resolve(PROJECT_ROOT, candidate);
    if (fsSync.existsSync(abs)) {
      return normalize(candidate);
    }
  }

  return null;
}

async function collectDependencyGraph(entryFiles, maxDepth = 3) {
  const visited = new Set();
  const graph = {};

  async function walk(file, depth) {
    if (depth > maxDepth) return;

    const normalized = normalize(file);

    if (visited.has(normalized)) return;
    visited.add(normalized);

    const res = await readProjectFile({
      path: normalized,
      maxBytes: 150000,
    });

    if (!res?.success || !res.content) {
      graph[normalized] = [];
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

async function buildContextChunks(files) {
  const chunks = [];

  for (const file of files) {
    const res = await readProjectFile({
      path: file,
      maxBytes: 180000,
    });

    if (!res?.success || !res.content) continue;

    chunks.push({
      path: file,
      content: res.content.slice(0, 12000),
    });
  }

  return chunks;
}

async function resolveFilenameHints(userMessage) {
  const hints = extractFilenameHints(userMessage);
  if (!hints.length) return [];

  const allFiles = await getAllProjectFiles();
  const matches = [];

  for (const hint of hints) {
    const base = path.basename(hint).toLowerCase();
    const exact = allFiles.filter(
      (f) => path.basename(f).toLowerCase() === base
    );

    const partial = allFiles.filter((f) =>
      path.basename(f).toLowerCase().includes(base)
    );

    matches.push(...exact, ...partial);
  }

  return uniq(matches);
}

export async function buildSmartContext({
  userMessage,
  maxFiles = 12,
  dependencyDepth = 2,
} = {}) {
  const rankedFiles = await rankRelevantFiles(userMessage, maxFiles);
  const filenameMatches = await resolveFilenameHints(userMessage);

  const seedFiles = uniq([...filenameMatches, ...rankedFiles]).slice(0, maxFiles);

  const dependencyGraph = await collectDependencyGraph(seedFiles, dependencyDepth);

  const dependencyFiles = uniq(Object.values(dependencyGraph).flat());

  const finalFiles = uniq([
    ...seedFiles,
    ...dependencyFiles,
  ]).slice(0, maxFiles);

  const chunks = await buildContextChunks(finalFiles);

  return {
    success: true,
    relevantFiles: rankedFiles,
    filenameMatches,
    dependencyGraph,
    files: finalFiles,
    chunks,
  };
}