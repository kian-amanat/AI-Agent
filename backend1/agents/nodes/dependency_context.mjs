/**
 * dependency_context.mjs
 * Expands candidate files by reading imports/re-exports from selected files.
 *
 * Inputs:
 * - workspacePath
 * - workspaceIndex (preferred, if available)
 * - symbolMatches / locatedFiles / grepResults / fileContext (optional)
 *
 * Outputs:
 * - dependencyFiles
 * - dependencyHints
 * - fileContext (expanded with dependency files when possible)
 */

import fs from "fs/promises";
import path from "path";

async function readSafe(absPath) {
  try {
    return await fs.readFile(absPath, "utf-8");
  } catch {
    return null;
  }
}

function normalizeRelPath(root, absPath) {
  return path.relative(root, absPath).replaceAll("\\", "/");
}

function isProbablyCodeFile(filePath) {
  return /\.(tsx?|jsx?|mjs|cjs|js|ts|json|md|css|scss|yaml|yml|html|xml)$/i.test(filePath);
}

function extractImports(code) {
  const out = new Set();
  const text = String(code || "");

  const patterns = [
    /from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /export\s+\*\s+from\s+['"]([^'"]+)['"]/g,
    /export\s+\{[^}]*\}\s+from\s+['"]([^'"]+)['"]/g,
  ];

  for (const regex of patterns) {
    let match;
    while ((match = regex.exec(text)) !== null) {
      const spec = match[1];
      if (spec && spec.startsWith(".")) out.add(spec);
    }
  }

  return [...out];
}

function candidatePathsForImport(absBaseFile, importPath) {
  const baseDir = path.dirname(absBaseFile);
  const raw = path.resolve(baseDir, importPath);

  return [
    raw,
    `${raw}.ts`,
    `${raw}.tsx`,
    `${raw}.js`,
    `${raw}.jsx`,
    `${raw}.mjs`,
    `${raw}.cjs`,
    `${raw}.json`,
    path.join(raw, "index.ts"),
    path.join(raw, "index.tsx"),
    path.join(raw, "index.js"),
    path.join(raw, "index.jsx"),
    path.join(raw, "index.mjs"),
    path.join(raw, "index.cjs"),
    path.join(raw, "index.json"),
  ];
}

function pickSeedFiles(state) {
  const candidates = [];

  for (const bucket of [
    state.symbolMatches,
    state.locatedFiles,
    state.grepResults,
    state.fileContext,
  ]) {
    if (!Array.isArray(bucket)) continue;

    for (const item of bucket) {
      if (!item) continue;
      if (typeof item === "string") {
        candidates.push(item);
        continue;
      }
      if (typeof item.path === "string") {
        candidates.push(item.path);
      }
    }
  }

  return [...new Set(candidates.filter(Boolean))];
}

function mergeContext(existing = [], added = []) {
  const map = new Map();

  for (const item of existing || []) {
    if (item?.path) map.set(item.path, item);
  }

  for (const item of added || []) {
    if (item?.path) map.set(item.path, item);
  }

  return [...map.values()];
}

export async function dependencyContextNode(state) {
  const root = state.workspacePath || process.cwd();
  const index = Array.isArray(state.workspaceIndex) ? state.workspaceIndex : [];
  const indexSet = new Set(index.map((f) => f.path));

  const fileContext = Array.isArray(state.fileContext) ? state.fileContext : [];
  const seedFiles = pickSeedFiles(state);

  const dependencySet = new Set();
  const dependencyHints = new Set();

  for (const rel of seedFiles.slice(0, 8)) {
    const abs = path.join(root, rel);
    const code = await readSafe(abs);
    if (!code) continue;

    const imports = extractImports(code);

    for (const imp of imports) {
      const candidates = candidatePathsForImport(abs, imp);

      let matched = false;
      for (const candidate of candidates) {
        const relCandidate = normalizeRelPath(root, candidate);
        if (relCandidate && !relCandidate.startsWith("..") && indexSet.has(relCandidate)) {
          dependencySet.add(relCandidate);
          matched = true;
          break;
        }
      }

      if (!matched) {
        const fallback = normalizeRelPath(root, path.resolve(path.dirname(abs), imp));
        if (fallback && !fallback.startsWith("..") && isProbablyCodeFile(fallback)) {
          dependencyHints.add(fallback);
        }
      }
    }
  }

  const dependencyFiles = [...dependencySet].sort();
  const hints = [...dependencyHints].sort();

  const extraContext = [];
  const existingPaths = new Set(fileContext.map((f) => f.path));

  for (const rel of dependencyFiles.slice(0, 8)) {
    if (existingPaths.has(rel)) continue;

    const abs = path.join(root, rel);
    const content = await readSafe(abs);
    if (!content) continue;

    extraContext.push({
      path: rel,
      content,
      size: content.length,
      score: 60,
      summary: "Dependency file",
    });
  }

  const mergedContext = mergeContext(fileContext, extraContext);

  return {
    dependencyFiles,
    dependencyHints: hints,
    fileContext: mergedContext,
    messages: [
      ...(state.messages || []),
      {
        role: "system",
        content: `Dependency graph expanded: ${dependencyFiles.length} file(s)`,
      },
    ],
  };
}