import path from "path";
import { PROJECT_ROOT } from "../config/openai.mjs";

export function normalizePath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "");
}

export function isInsideProjectRoot(absPath, projectRoot = PROJECT_ROOT) {
  const root = path.resolve(projectRoot);
  const target = path.resolve(absPath);
  return target === root || target.startsWith(root + path.sep);
}

export function sanitizeFilename(name) {
  return (
    String(name || "upload.bin")
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/^_+/, "")
      .slice(0, 180) || "upload.bin"
  );
}

export function inferLanguageFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".tsx" || ext === ".ts") return "ts";
  if (ext === ".jsx" || ext === ".js") return "js";
  if (ext === ".css") return "css";
  if (ext === ".scss") return "scss";
  if (ext === ".json") return "json";
  if (ext === ".md") return "md";
  if (ext === ".html") return "html";
  return "";
}

export function inferMimeTypeFromPath(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    case ".ts":
    case ".tsx":
      return "text/typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "text/javascript";
    case ".css":
      return "text/css";
    case ".scss":
      return "text/scss";
    case ".md":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".yaml":
    case ".yml":
      return "text/yaml";
    case ".html":
      return "text/html";
    case ".xml":
      return "application/xml";
    case ".txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

export function isImageMime(mimeType, filePath = "") {
  const mime = String(mimeType || "").toLowerCase();
  const ext = path.extname(filePath).toLowerCase();
  return (
    mime.startsWith("image/") ||
    [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg"].includes(ext)
  );
}

export function isTextLikeAttachment(filePath, mimeType = "") {
  const mime = String(mimeType || "").toLowerCase();
  const ext = path.extname(filePath).toLowerCase();

  if (mime.startsWith("text/")) return true;
  if (
    [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".css",
      ".scss",
      ".md",
      ".json",
      ".yaml",
      ".yml",
      ".html",
      ".xml",
      ".txt",
      ".env",
    ].includes(ext)
  ) {
    return true;
  }

  return [
    "application/json",
    "application/javascript",
    "application/typescript",
    "application/xml",
    "application/xhtml+xml",
  ].includes(mime);
}

// PDFs are text-extractable server-side, so they work with ANY model (no vision
// needed) — the router only gates on images, which genuinely need vision.
export function isPdfAttachment(filePath, mimeType = "") {
  const mime = String(mimeType || "").toLowerCase();
  const ext = path.extname(filePath).toLowerCase();
  return mime === "application/pdf" || ext === ".pdf";
}

export function buildResolvedPathCandidates(candidatePath, projectRoot = PROJECT_ROOT) {
  const cleaned = normalizePath(candidatePath).replace(/^\/+/, "");
  const variants = new Set([cleaned]);

  if (cleaned.startsWith("frontend/")) variants.add(cleaned.slice("frontend/".length));
  if (cleaned.startsWith("backend/")) variants.add(cleaned.slice("backend/".length));

  const resolved = [];
  for (const variant of variants) {
    if (!variant) continue;
    resolved.push(path.resolve(projectRoot, variant));
    resolved.push(path.resolve(projectRoot, "frontend", variant));
    resolved.push(path.resolve(projectRoot, "backend", variant));
  }

  return [...new Set(resolved)];
}