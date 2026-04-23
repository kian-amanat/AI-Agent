// tools/workspace_utils.js
import path from "path";

export const WORKSPACE_ROOT = path.join(process.cwd(), "workspace");

/**
 * نرمال‌سازی مسیر نسبی نسبت به WORKSPACE_ROOT
 * - 'workspace/foo/bar' -> 'foo/bar'
 * - '/absolute/path/...' را قبول نکن (برای امنیت)
 */
export function normalizeWorkspacePath(relPath) {
  if (!relPath || typeof relPath !== "string") {
    throw new Error("Path is required and must be a string.");
  }

  // جلوگیری از مسیرهای مطلق (security)
  if (path.isAbsolute(relPath)) {
    throw new Error("Absolute paths are not allowed. Use paths relative to the workspace root.");
  }

  // اگر با 'workspace/' شروع شود، حذفش کن
  if (relPath.startsWith("workspace/")) {
    relPath = relPath.slice("workspace/".length);
  }

  // نرمال‌سازی (حذف ".." و "."، ولی بدون خروج از workspace)
  const normalized = path.normalize(relPath).replace(/^(\.\.[/\\])+/, "");
  return normalized;
}

export function resolveWorkspacePath(relPath) {
  const safeRelPath = normalizeWorkspacePath(relPath);
  return {
    safeRelPath,
    fullPath: path.join(WORKSPACE_ROOT, safeRelPath),
  };
}
