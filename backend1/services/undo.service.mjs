// services/undo.service.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const HISTORY_ROOT = path.resolve(PROJECT_ROOT, ".agent-history");

console.log("[UNDO] PROJECT_ROOT =", PROJECT_ROOT);
console.log("[UNDO] HISTORY_ROOT  =", HISTORY_ROOT);


/**
 * نرمال‌سازی شناسه‌ها:
 * - اگر از قبل با prefix شروع شود (مثلاً sess_...)، همان را برمی‌گرداند.
 * - اگر نه، prefix را اضافه می‌کند (sess_${id} / req_${id}).
 */
function normalizeId(prefix, id) {
  if (!id) {
    throw new Error(`${prefix.toUpperCase()}_ID is required for undo`);
  }
  const prefixed = `${prefix}_`;
  return id.startsWith(prefixed) ? id : `${prefixed}${id}`;
}

/**
 * مسیر history برای یک session/request
 *
 * توجه: این تابع مطمئن می‌شود که شناسه‌ها
 * دقیقاً با چیزی که در codegen/history روی دیسک نوشته شده یکی باشند:
 *   .agent-history/sess_.../req_...
 */
function getRequestHistoryDir(sessionId, requestId) {
  if (!sessionId) throw new Error("sessionId is required for undo");
  if (!requestId) throw new Error("requestId is required for undo");

  const normalizedSessionId = normalizeId("sess", sessionId);
  const normalizedRequestId = normalizeId("req", requestId);

  const dir = path.join(HISTORY_ROOT, normalizedSessionId, normalizedRequestId);

  // لاگ تشخیصی برای کمک به دیباگ
  console.log(
    `[UNDO] History dir for undo: ${dir} (sessionId=${normalizedSessionId}, requestId=${normalizedRequestId})`
  );

  return dir;
}

/**
 * meta.json را می‌خواند.
 */
function loadRequestMeta(sessionId, requestId) {
  const dir = getRequestHistoryDir(sessionId, requestId);
  const metaPath = path.join(dir, "meta.json");

  console.log(
    `[UNDO] Looking for meta at: ${metaPath} (sessionId=${sessionId}, requestId=${requestId})`
  );

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
