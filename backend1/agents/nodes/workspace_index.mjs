/**
 * workspace_index.mjs
 * Builds a structured index of the entire workspace.
 */

import path from "path";
import fs from "fs/promises";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".cache",
  ".vscode",
  "uploads",
  ".agent-history",
]);

const CODE_EXTENSIONS = new Set([
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
  ".yml",
  ".yaml",
  ".html",
  ".xml",
]);

async function safeStat(p) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

async function walk(root, base = root, out = [], depth = 0, maxDepth = 8) {
  if (depth > maxDepth) return out;

  let entries;
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name)) continue;

    const abs = path.join(base, e.name);
    const rel = path.relative(root, abs);

    if (e.isDirectory()) {
      await walk(root, abs, out, depth + 1, maxDepth);
      continue;
    }

    const ext = path.extname(e.name).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) continue;

    const stat = await safeStat(abs);

    out.push({
      path: rel.replaceAll("\\", "/"),
      name: e.name,
      ext,
      size: stat?.size || 0,
    });
  }

  return out;
}

export async function workspaceIndexNode(state) {
  const root = state.workspacePath || process.cwd();
  const files = await walk(root);

  const workspaceMap = {};
  for (const f of files) {
    workspaceMap[f.path] = f;
  }

  return {
    workspaceIndex: files,
    workspaceMap,
    messages: [
      ...(state.messages || []),
      { role: "system", content: `Indexed workspace: ${files.length} files` },
    ],
  };
}