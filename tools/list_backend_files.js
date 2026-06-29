import fs from "fs/promises";
import path from "path";

const PROJECT_ROOT = process.env.WORKSPACE_PATH || process.cwd();

const DEFAULT_IGNORES = new Set([
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

function normalizeDir(inputDir) {
  if (!inputDir || typeof inputDir !== "string") return "";
  // If it's an absolute path, make it relative to PROJECT_ROOT so the
  // path.resolve(PROJECT_ROOT, relDir) dance works correctly.
  if (path.isAbsolute(inputDir)) {
    const rel = path.relative(PROJECT_ROOT, inputDir);
    // If outside PROJECT_ROOT (starts with ".."), fall back to root
    if (rel.startsWith("..")) return "";
    return rel.replace(/\\/g, "/") || "";
  }
  let dir = inputDir.trim().replace(/^["'`]+|["'`]+$/g, "");
  dir = dir.replace(/^\.?\//, "");
  return path.normalize(dir).replace(/\\/g, "/");
}

function isInsideProjectRoot(absPath) {
  const root = path.resolve(PROJECT_ROOT);
  const target = path.resolve(absPath);
  return target === root || target.startsWith(root + path.sep);
}

async function safeStat(absPath) {
  try {
    return await fs.stat(absPath);
  } catch {
    return null;
  }
}

async function readPreview(absPath, maxChars = 200) {
  try {
    const stat = await fs.stat(absPath);
    if (!stat.isFile() || stat.size > 100_000) return "";

    const content = await fs.readFile(absPath, "utf8");
    return content.slice(0, maxChars).replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

export async function listBackendFiles({
  dir = "",
  maxDepth = 10,
  includeFiles = true,
  includeDirs = true,
  includeMeta = true,
  ignore = [],
  __json_error__,
} = {}) {
  try {
    if (__json_error__) {
      return {
        success: false,
        error: `Invalid JSON arguments for listBackendFiles: ${String(__json_error__).slice(0, 200)}...`,
        files: [],
        stdout: "",
        stderr: "",
      };
    }

    const relDir = normalizeDir(dir);
    const baseDir = relDir ? path.resolve(PROJECT_ROOT, relDir) : PROJECT_ROOT;

    if (!isInsideProjectRoot(baseDir)) {
      return {
        success: false,
        error: "Access denied: directory is outside project root",
        files: [],
        stdout: "",
        stderr: "",
      };
    }

    const baseStat = await safeStat(baseDir);
    if (!baseStat || !baseStat.isDirectory()) {
      return {
        success: false,
        error: `Path is not a directory: ${relDir || "."}`,
        files: [],
        stdout: "",
        stderr: "",
      };
    }

    const files = [];
    const ignoreSet = new Set([...DEFAULT_IGNORES, ...ignore]);

    async function walk(currentAbsDir, currentRelDir, depth) {
      if (depth > maxDepth) return;

      const entries = await fs.readdir(currentAbsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (ignoreSet.has(entry.name)) continue;

        const entryAbs = path.join(currentAbsDir, entry.name);
        const entryRel = currentRelDir
          ? path.join(currentRelDir, entry.name)
          : entry.name;

        const relNorm = entryRel.replace(/\\/g, "/");
        const stat = includeMeta ? await safeStat(entryAbs) : null;

        const item = {
          name: entry.name,
          path: relNorm,
          is_dir: entry.isDirectory(),
        };

        if (includeMeta && stat) {
          item.size = stat.size;
          item.mtimeMs = stat.mtimeMs;
          item.ext = entry.isDirectory()
            ? ""
            : path.extname(entry.name).replace(".", "");
        }

        if (entry.isDirectory()) {
          if (includeDirs) files.push(item);
          await walk(entryAbs, entryRel, depth + 1);
        } else {
          if (includeFiles) {
            if (includeMeta) {
              item.preview = await readPreview(entryAbs, 180);
            }
            files.push(item);
          }
        }
      }
    }

    await walk(baseDir, relDir, 0);

    return {
      success: true,
      files,
      stdout: "",
      stderr: "",
      meta: {
        root: relDir || ".",
        count: files.length,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err?.message || String(err),
      files: [],
      stdout: "",
      stderr: "",
    };
  }
}