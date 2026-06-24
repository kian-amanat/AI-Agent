import fs from "fs/promises";
import path from "path";

const PROJECT_ROOT = process.env.WORKSPACE_PATH || process.cwd();

function normalizePath(inputPath) {
  if (!inputPath || typeof inputPath !== "string") return "";
  let p = inputPath.trim().replace(/^["'`]+|["'`]+$/g, "");
  p = p.replace(/^\.?\//, "");
  return path.normalize(p).replace(/\\/g, "/");
}

function isInsideProjectRoot(absPath) {
  const root = path.resolve(PROJECT_ROOT);
  const target = path.resolve(absPath);
  return target === root || target.startsWith(root + path.sep);
}

function looksBinary(buffer) {
  const length = Math.min(buffer.length, 8000);
  let suspicious = 0;

  for (let i = 0; i < length; i++) {
    const byte = buffer[i];
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious++;
  }

  return suspicious / Math.max(1, length) > 0.08;
}

function sliceLines(content, startLine, endLine) {
  const lines = content.split(/\r?\n/);

  const start = Number.isFinite(startLine) && startLine > 0 ? startLine : 1;
  const end = Number.isFinite(endLine) && endLine > 0 ? endLine : lines.length;

  return lines.slice(start - 1, end).join("\n");
}

export async function readProjectFile({
  path: inputPath,
  startLine,
  endLine,
  maxBytes = 500_000,
  previewLines = 0,
} = {}) {
  try {
    const relPath = normalizePath(inputPath);

    if (!relPath) {
      return {
        success: false,
        error: "path is required",
      };
    }

    const absPath = path.resolve(PROJECT_ROOT, relPath);

    if (!isInsideProjectRoot(absPath)) {
      return {
        success: false,
        error: "Access denied: path is outside project root",
      };
    }

    const stat = await fs.stat(absPath);

    if (!stat.isFile()) {
      return {
        success: false,
        error: "Path is not a file",
      };
    }

    if (stat.size > maxBytes) {
      return {
        success: false,
        error: `File too large (${stat.size} bytes). Max allowed is ${maxBytes} bytes.`,
        meta: {
          path: relPath,
          size: stat.size,
          too_large: true,
        },
      };
    }

    const buffer = await fs.readFile(absPath);

    if (looksBinary(buffer)) {
      return {
        success: false,
        error: "Binary file cannot be read as text",
        meta: {
          path: relPath,
          size: stat.size,
          binary: true,
        },
      };
    }

    let content = buffer.toString("utf8");

    if (typeof startLine === "number" || typeof endLine === "number") {
      content = sliceLines(content, startLine, endLine);
    }

    const lines = content.split(/\r?\n/);
    const preview =
      previewLines > 0 ? lines.slice(0, previewLines).join("\n") : "";

    return {
      success: true,
      path: relPath,
      content,
      meta: {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        lines: lines.length,
        ext: path.extname(relPath).replace(".", ""),
        preview: preview || undefined,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err?.message || String(err),
    };
  }
}