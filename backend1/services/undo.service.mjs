// services/undo.service.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// PROJECT_ROOT همان منطق سایر سرویس‌ها
const PROJECT_ROOT = path.resolve(__dirname, "..");
// دایرکتوری اصلی history که در codegen_agent تعریف کردیم
const HISTORY_ROOT = path.resolve(PROJECT_ROOT, ".agent-history");

/**
 * مسیر history برای یک session/request
 */
function getRequestHistoryDir(sessionId, requestId) {
  if (!sessionId) throw new Error("sessionId is required for undo");
  if (!requestId) throw new Error("requestId is required for undo");

  return path.join(HISTORY_ROOT, sessionId, requestId);
}

/**
 * meta.json را می‌خواند.
 */
function loadRequestMeta(sessionId, requestId) {
  const dir = getRequestHistoryDir(sessionId, requestId);
  const metaPath = path.join(dir, "meta.json");

  if (!fs.existsSync(metaPath)) {
    throw new Error(
      `No history meta found for session=${sessionId}, request=${requestId}`
    );
  }

  const raw = fs.readFileSync(metaPath, "utf8");
  return JSON.parse(raw);
}

/**
 * یک فایل را بر اساس متادیتا undo می‌کند:
 * - اگر existedBefore === true → snapshot را به فایل اصلی برمی‌گرداند.
 * - اگر existedBefore === false → فایل فعلی را حذف می‌کند (اگر وجود دارد).
 */
function undoSingleFile(entry) {
  const { relativePath, fullPath, existedBefore, snapshotPath } = entry;

  if (existedBefore) {
    if (!snapshotPath) {
      console.warn(
        `⚠️  No snapshotPath for ${relativePath} although existedBefore=true`
      );
      return {
        file: relativePath,
        action: "restore_failed",
        reason: "missing_snapshot",
      };
    }

    // snapshotPath در meta نسبی نسبت به PROJECT_ROOT ذخیره شده
    const snapshotFullPath = path.resolve(PROJECT_ROOT, snapshotPath);

    if (!fs.existsSync(snapshotFullPath)) {
      console.warn(
        `⚠️  Snapshot file not found for ${relativePath}: ${snapshotFullPath}`
      );
      return {
        file: relativePath,
        action: "restore_failed",
        reason: "snapshot_not_found",
      };
    }

    const snapshotContent = fs.readFileSync(snapshotFullPath, "utf8");

    const targetPath = fullPath || path.resolve(PROJECT_ROOT, relativePath);
    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    fs.writeFileSync(targetPath, snapshotContent, "utf8");

    console.log(`🔄 Restored file from snapshot: ${relativePath}`);
    return {
      file: relativePath,
      action: "restored",
    };
  }

  // existedBefore === false → این فایل جدید بود، باید حذفش کنیم
  const targetPath = fullPath || path.resolve(PROJECT_ROOT, relativePath);

  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath);
    console.log(`🗑️  Removed newly created file: ${relativePath}`);
    return {
      file: relativePath,
      action: "deleted",
    };
  }

  console.log(
    `ℹ️  File already missing (nothing to delete): ${relativePath}`
  );
  return {
    file: relativePath,
    action: "no_op",
    reason: "file_not_found",
  };
}

/**
 * عملی کردن Undo برای یک sessionId + requestId.
 * هیچ تماس LLM ندارد؛ فقط روی دیسک کار می‌کند.
 */
export function undoRequestChanges({ sessionId, requestId }) {
  if (!sessionId || !requestId) {
    throw new Error("sessionId and requestId are required");
  }

  const meta = loadRequestMeta(sessionId, requestId);
  if (!Array.isArray(meta.files) || meta.files.length === 0) {
    throw new Error(
      `No file entries found in meta for session=${sessionId}, request=${requestId}`
    );
  }

  const results = {
    sessionId,
    requestId,
    files: [],
    stats: {
      total: meta.files.length,
      restored: 0,
      deleted: 0,
      no_op: 0,
      failed: 0,
    },
  };

  for (const entry of meta.files) {
    try {
      const res = undoSingleFile(entry);
      results.files.push(res);

      switch (res.action) {
        case "restored":
          results.stats.restored++;
          break;
        case "deleted":
          results.stats.deleted++;
          break;
        case "no_op":
          results.stats.no_op++;
          break;
        default:
          results.stats.failed++;
          break;
      }
    } catch (err) {
      console.error(
        `❌ Failed to undo file ${entry.relativePath}:`,
        err.message
      );
      results.files.push({
        file: entry.relativePath,
        action: "failed",
        error: err.message,
      });
      results.stats.failed++;
    }
  }

  return results;
}
