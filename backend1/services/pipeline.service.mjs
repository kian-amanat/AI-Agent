import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PIPELINE_SCRIPT = path.resolve(process.cwd(), "../pipeline_agent.mjs");

export async function runPipeline({ message, sessionId, requestId }) {
  console.log("🚀 Starting full pipeline...");
  console.log("[PIPELINE] starting (raw args)", { sessionId, requestId });

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

  // ❗ مهم: دیگر اینجا هیچ fallback تصادفی برای requestId نمی‌سازیم.
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

  return new Promise((resolve, reject) => {
    const child = spawn("node", [PIPELINE_SCRIPT], {
      env: {
        ...process.env,
        USER_MESSAGE: userMessage,
        USER_SESSION_ID: userSessionId,
        USER_REQUEST_ID: userRequestId,
      },
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (data) => process.stdout.write(data));
    child.stderr.on("data", (data) => process.stderr.write(data));

    const timer = setTimeout(() => {
      console.error("⏱️ [PIPELINE] Killing child process after timeout");
      child.kill();
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
