import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// services/ → backend1/ → ai-sandbox/
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const PIPELINE_SCRIPT = process.env.PIPELINE_SCRIPT_PATH
  ? path.resolve(process.env.PIPELINE_SCRIPT_PATH)
  : path.resolve(PROJECT_ROOT, "pipeline_agent.mjs");

const SETTINGS_PATH = path.join(PROJECT_ROOT, "backend1", "data", "settings.json");
let _cachedSettings = null;

function loadSettings() {
  if (_cachedSettings) return _cachedSettings;
  try {
    _cachedSettings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
  } catch {
    _cachedSettings = {};
  }
  return _cachedSettings;
}

function resolveWorkspacePath(workspacePath) {
  if (typeof workspacePath === "string" && workspacePath.trim()) {
    return path.resolve(workspacePath.trim());
  }
  return PROJECT_ROOT;
}

export async function runPipeline({
  message,
  sessionId,
  requestId,
  attachmentPaths = [],
  audioPath = "",
  workspacePath = "",
}) {
  console.log("🚀 Starting full pipeline...");
  console.log("[PIPELINE] starting (raw args)", {
    sessionId,
    requestId,
    attachmentPaths,
    audioPath,
    workspacePath,
  });

  const userMessage =
    typeof message === "string" && message.trim()
      ? message.trim()
      : (process.env.USER_MESSAGE || "").trim();

  const userSessionId =
    typeof sessionId === "string" && sessionId.trim()
      ? sessionId.trim()
      : (process.env.USER_SESSION_ID || "").trim();

  const userRequestId =
    typeof requestId === "string" && requestId.trim()
      ? requestId.trim()
      : (process.env.USER_REQUEST_ID || "").trim();

  const userAttachmentPaths = Array.isArray(attachmentPaths) ? attachmentPaths : [];
  const userAudioPath = typeof audioPath === "string" ? audioPath.trim() : "";
  const resolvedWorkspace = resolveWorkspacePath(workspacePath);

  if (!userSessionId || !userRequestId) {
    const err = new Error(
      `runPipeline called without valid sessionId/requestId. Got sessionId="${userSessionId}", requestId="${userRequestId}"`
    );
    console.error("❌ [PIPELINE] Invalid IDs:", {
      sessionId: userSessionId,
      requestId: userRequestId,
    });
    throw err;
  }

  const settings = loadSettings();

  console.log("[PIPELINE] effective env IDs", {
    USER_SESSION_ID: userSessionId,
    USER_REQUEST_ID: userRequestId,
  });
  console.log("[PIPELINE] workspace →", resolvedWorkspace);
  console.log("[PIPELINE] script →", PIPELINE_SCRIPT);
  console.log("[PIPELINE] files", userAttachmentPaths);
  console.log("[PIPELINE] audio", userAudioPath || "(none)");

  return new Promise((resolve, reject) => {
    const child = spawn("node", [PIPELINE_SCRIPT], {
      env: {
        ...process.env,
        USER_MESSAGE: userMessage,
        USER_SESSION_ID: userSessionId,
        USER_REQUEST_ID: userRequestId,
        USER_AUDIO_PATH: userAudioPath,
        USER_ATTACHMENT_PATHS: JSON.stringify(userAttachmentPaths),
        WORKSPACE_PATH: resolvedWorkspace,
        USER_API_KEY: settings.textApiKey || "",
        USER_BASE_URL: settings.textBaseUrl || "",
        USER_MODEL: settings.textModel || "",
      },
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (data) => {
      process.stdout.write(data);
    });

    child.stderr.on("data", (data) => {
      process.stderr.write(data);
    });

    const timeoutMs = Number(process.env.PIPELINE_TIMEOUT_MS || 600000);

    const timer = setTimeout(() => {
      console.error("⏱️ [PIPELINE] Killing child process after timeout");
      child.kill("SIGTERM");

      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5000);

      reject(new Error(`Pipeline timed out after ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        console.log("✅ Pipeline completed successfully");
        resolve();
      } else {
        reject(new Error(`Pipeline exited with code ${code}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}