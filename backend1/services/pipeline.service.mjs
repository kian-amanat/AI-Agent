import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Two levels up: services/ → backend1/ → ai-sandbox/
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const PIPELINE_SCRIPT = path.resolve(process.cwd(), "../pipeline_agent.mjs");

const SETTINGS_PATH = path.join(PROJECT_ROOT, "backend1", "data", "settings.json");
let _cachedSettings = null;
function loadSettings() {
  if (_cachedSettings) return _cachedSettings;
  try {
    _cachedSettings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
  } catch { _cachedSettings = {}; }
  return _cachedSettings;
}

export async function runPipeline({
  message,
  sessionId,
  requestId,
  attachmentPaths = [],
  audioPath = "",
  workspacePath = "",   // ← NEW: passed from plannerAgent
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
      ? message
      : (process.env.USER_MESSAGE || "").trim();

  const userSessionId =
    typeof sessionId === "string" && sessionId.trim()
      ? sessionId.trim()
      : (process.env.USER_SESSION_ID || "").trim();

  const userRequestId =
    typeof requestId === "string" && requestId.trim()
      ? requestId.trim()
      : (process.env.USER_REQUEST_ID || "").trim();

  const userAttachmentPaths = Array.isArray(attachmentPaths)
    ? attachmentPaths
    : [];

  const userAudioPath =
    typeof audioPath === "string" ? audioPath.trim() : "";

  // Resolve workspace: use provided path, else fall back to PROJECT_ROOT
  const resolvedWorkspace =
    typeof workspacePath === "string" && workspacePath.trim()
      ? workspacePath.trim()
      : PROJECT_ROOT;

  if (!userSessionId || !userRequestId) {
    const err = new Error(
      `runPipeline called without valid sessionId/requestId. ` +
        `Got sessionId="${userSessionId}", requestId="${userRequestId}"`
    );
    console.error("❌ [PIPELINE] Invalid IDs:", {
      sessionId: userSessionId,
      requestId: userRequestId,
    });
    throw err;
  }

  console.log("[PIPELINE] effective env IDs", {
    USER_SESSION_ID: userSessionId,
    USER_REQUEST_ID: userRequestId,
  });
  console.log("[PIPELINE] workspace →", resolvedWorkspace);
  console.log("[PIPELINE] files", userAttachmentPaths);
  console.log("[PIPELINE] audio", userAudioPath || "(none)");

  return new Promise((resolve, reject) => {
    const child = spawn("node", [PIPELINE_SCRIPT], {
      env: {
        ...process.env,

        USER_MESSAGE: userMessage,
        USER_SESSION_ID: userSessionId,
        USER_REQUEST_ID: userRequestId,

        // 🎙️ Whisper
        USER_AUDIO_PATH: userAudioPath,

        // 📎 File Agent
        USER_ATTACHMENT_PATHS: JSON.stringify(userAttachmentPaths),

        // 📁 Workspace — pipeline_agent.mjs should use this as the root
        // for all file reads/writes instead of process.cwd()
        WORKSPACE_PATH: resolvedWorkspace,

        // 🔑 User's stored API credentials — forwarded to all sub-agents
        ...(() => {
          const s = loadSettings();
          return {
            USER_API_KEY: s.textApiKey || "",
            USER_BASE_URL: s.textBaseUrl || "",
            USER_MODEL: s.textModel || "",
          };
        })(),
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

    const timer = setTimeout(() => {
      console.error("⏱️ [PIPELINE] Killing child process after timeout");
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5000);
      reject(new Error("Pipeline timed out after 5 minutes"));
    }, 300000);

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
