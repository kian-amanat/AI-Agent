// services/undo.service.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// [KODO] Fallback root — used only when meta.json has no workspacePath
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_HISTORY_ROOT = path.resolve(PROJECT_ROOT, ".agent-history");

console.log("[UNDO] PROJECT_ROOT =", PROJECT_ROOT);
console.log("[UNDO] DEFAULT_HISTORY_ROOT =", DEFAULT_HISTORY_ROOT);

function normalizeId(prefix, id) {
  if (!id) {
    throw new Error(`${prefix.toUpperCase()}_ID is required for undo`);
  }
  const prefixed = `${prefix}_`;
  return id.startsWith(prefixed) ? id : `${prefixed}${id}`;
}

// [KODO] Try to find the history dir by checking both the workspace-based
// path (from meta.json) and the default fallback path.
function getRequestHistoryDir(sessionId, requestId, workspacePath = null) {
  if (!sessionId) throw new Error("sessionId is required for undo");
  if (!requestId) throw new Error("requestId is required for undo");

  const normalizedSessionId = normalizeId("sess", sessionId);
  const normalizedRequestId = normalizeId("req", requestId);

  // If a workspacePath is provided, try that first
  if (workspacePath) {
    const workspaceHistory = path.resolve(workspacePath, ".agent-history");
    const dir = path.join(workspaceHistory, normalizedSessionId, normalizedRequestId);
    console.log(`[UNDO] Trying workspace history dir: ${dir}`);
    if (fs.existsSync(dir)) return dir;
  }

  // Fall back to default (ai-sandbox)
  const fallbackDir = path.join(DEFAULT_HISTORY_ROOT, normalizedSessionId, normalizedRequestId);
  console.log(`[UNDO] Trying fallback history dir: ${fallbackDir}`);
  return fallbackDir;
}

function loadRequestMeta(sessionId, requestId) {
  // First try without a workspacePath to find meta.json anywhere it might be
  // We search all known history roots
  const normalizedSessionId = normalizeId("sess", sessionId);
  const normalizedRequestId = normalizeId("req", requestId);

  // Collect candidate roots to search
  const candidateRoots = [DEFAULT_HISTORY_ROOT];

  // Also check if there's a workspace-based history by scanning auth_sessions
  // (we do this by trying common locations)
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  if (homeDir) {
    // Try to read token file to get workspace path
    const tokenFile = path.join(homeDir, ".kodo", "token.json");
    if (fs.existsSync(tokenFile)) {
      try {
        // We can't easily query the DB here, so we'll rely on meta.json
        // having the workspacePath stored in it (added by codegen)
      } catch {}
    }
  }

  for (const historyRoot of candidateRoots) {
    const dir = path.join(historyRoot, normalizedSessionId, normalizedRequestId);
    const metaPath = path.join(dir, "meta.json");

    console.log(`[UNDO] Looking for meta at: ${metaPath}`);

    if (fs.existsSync(metaPath)) {
      const raw = fs.readFileSync(metaPath, "utf8");
      return JSON.parse(raw);
    }
  }

  // Last resort: scan for meta.json in workspace-based histories
  // by looking at the fullPath stored in any existing meta
  throw new Error(
    `No history meta found for session=${sessionId}, request=${requestId}`
  );
}

// [KODO] Improved: reads workspacePath from meta.json to resolve snapshot paths correctly
function undoSingleFile(entry, workspacePath) {
  const { relativePath, fullPath, existedBefore, snapshotPath } = entry;

  // The effective root for resolving paths: workspace if available, else PROJECT_ROOT
  const effectiveRoot = workspacePath || PROJECT_ROOT;

  if (existedBefore) {
    if (!snapshotPath) {
      console.warn(`⚠️  No snapshotPath for ${relativePath} although existedBefore=true`);
      return { file: relativePath, action: "restore_failed", reason: "missing_snapshot" };
    }

    // snapshotPath may be relative to PROJECT_ROOT (old behavior) or absolute
    let snapshotFullPath;
    if (path.isAbsolute(snapshotPath)) {
      snapshotFullPath = snapshotPath;
    } else {
      // Try relative to effectiveRoot first, then PROJECT_ROOT
      snapshotFullPath = path.resolve(effectiveRoot, snapshotPath);
      if (!fs.existsSync(snapshotFullPath)) {
        snapshotFullPath = path.resolve(PROJECT_ROOT, snapshotPath);
      }
    }

    if (!fs.existsSync(snapshotFullPath)) {
      console.warn(`⚠️  Snapshot file not found for ${relativePath}: ${snapshotFullPath}`);
      return { file: relativePath, action: "restore_failed", reason: "snapshot_not_found" };
    }

    const snapshotContent = fs.readFileSync(snapshotFullPath, "utf8");

    // Resolve target: use fullPath if absolute, else resolve relative to effectiveRoot
    let targetPath;
    if (fullPath && path.isAbsolute(fullPath)) {
      targetPath = fullPath;
    } else {
      targetPath = path.resolve(effectiveRoot, relativePath);
    }

    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    fs.writeFileSync(targetPath, snapshotContent, "utf8");
    console.log(`🔄 Restored file from snapshot: ${relativePath} → ${targetPath}`);
    return { file: relativePath, action: "restored" };
  }

  // existedBefore === false → new file, delete it
  let targetPath;
  if (fullPath && path.isAbsolute(fullPath)) {
    targetPath = fullPath;
  } else {
    targetPath = path.resolve(effectiveRoot, relativePath);
  }

  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath);
    console.log(`🗑️  Removed newly created file: ${relativePath}`);
    return { file: relativePath, action: "deleted" };
  }

  console.log(`ℹ️  File already missing (nothing to delete): ${relativePath}`);
  return { file: relativePath, action: "no_op", reason: "file_not_found" };
}

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

  // [KODO] Read workspacePath stored in meta by codegen_agent
  const workspacePath = meta.workspacePath || null;
  if (workspacePath) {
    console.log(`[UNDO] Using workspace from meta: ${workspacePath}`);
  } else {
    console.warn(`[UNDO] No workspacePath in meta, using PROJECT_ROOT fallback`);
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
      const res = undoSingleFile(entry, workspacePath);
      results.files.push(res);

      switch (res.action) {
        case "restored": results.stats.restored++; break;
        case "deleted":  results.stats.deleted++;  break;
        case "no_op":    results.stats.no_op++;    break;
        default:         results.stats.failed++;   break;
      }
    } catch (err) {
      console.error(`❌ Failed to undo file ${entry.relativePath}:`, err.message);
      results.files.push({ file: entry.relativePath, action: "failed", error: err.message });
      results.stats.failed++;
    }
  }

  return results;
}
