import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PIPELINE_SCRIPT = path.resolve(process.cwd(), "../pipeline_agent.mjs");

export async function runPipeline({ message, sessionId, requestId }) {
  console.log("🚀 Starting full pipeline...");

  const userMessage =
    typeof message === "string" && message.trim()
      ? message
      : process.env.USER_MESSAGE || "";

  const userSessionId =
    typeof sessionId === "string" && sessionId.trim()
      ? sessionId
      : process.env.USER_SESSION_ID || "";

  const userRequestId =
    typeof requestId === "string" && requestId.trim()
      ? requestId
      : process.env.USER_REQUEST_ID ||
        `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

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
