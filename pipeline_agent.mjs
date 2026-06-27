import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parsePathList(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => String(item || "").trim())
        .filter(Boolean);
    }
  } catch {
    // ignore JSON parse errors
  }

  return raw
    .split(/[,\n;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractSingleTextOutput(output) {
  const text = String(output || "").trim();
  if (!text) return "";

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.transcribed_text === "string") {
        return parsed.transcribed_text.trim();
      }
      if (typeof parsed.text === "string") {
        return parsed.text.trim();
      }
      if (typeof parsed.content === "string") {
        return parsed.content.trim();
      }
    }
  } catch {
    // not JSON
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines[lines.length - 1] || text;
}

function extractFileAnalysisOutput(output) {
  const text = String(output || "").trim();
  if (!text) return "";

  const marker = "[Structured_File_Analysis_JSON]";
  const markerIndex = text.indexOf(marker);

  if (markerIndex !== -1) {
    const beforeMarker = text.slice(0, markerIndex).trim();
    const firstFileIndex = beforeMarker.indexOf("File:");
    if (firstFileIndex !== -1) {
      return beforeMarker.slice(firstFileIndex).trim();
    }
    return beforeMarker || text.slice(markerIndex + marker.length).trim();
  }

  const firstFileIndex = text.indexOf("File:");
  if (firstFileIndex !== -1) {
    return text.slice(firstFileIndex).trim();
  }

  return text;
}

const userMessage = String(
  process.env.USER_MESSAGE || process.argv.slice(2).join(" ")
).trim();
const userAudioPath = String(process.env.USER_AUDIO_PATH || "").trim();
const userAttachmentPaths = parsePathList(
  process.env.USER_ATTACHMENT_PATHS || process.env.USER_FILES || ""
);
const userSessionId = process.env.USER_SESSION_ID || "";
const userRequestId =
  process.env.USER_REQUEST_ID ||
  `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// [KODO] Workspace path bound by the VS Code extension for this user session.
// Passed from pipeline.service.mjs → pipeline_agent.mjs → all sub-agents.
const userWorkspacePath = String(process.env.WORKSPACE_PATH || "").trim();

// User's stored API credentials — forwarded from pipeline.service.mjs
const userApiKey = String(process.env.USER_API_KEY || "").trim();
const userBaseUrl = String(process.env.USER_BASE_URL || "").trim();
const userModel = String(process.env.USER_MODEL || "").trim();

if (!userMessage && !userAudioPath && userAttachmentPaths.length === 0) {
  console.error("Usage: node pipeline_agent.mjs <your request>");
  console.error('   or: USER_MESSAGE="your request" node pipeline_agent.mjs');
  console.error('   or: USER_AUDIO_PATH="/path/to/audio.mp3" node pipeline_agent.mjs');
  console.error(
    '   or: USER_ATTACHMENT_PATHS=\'["/path/a.png","/path/b.pdf"]\' node pipeline_agent.mjs'
  );
  process.exit(1);
}

console.log("🚀 Starting Pipeline...\n");
if (userAudioPath) console.log(`🎙️  Audio: "${userAudioPath}"`);
if (userAttachmentPaths.length) console.log(`📎 Attachments: ${userAttachmentPaths.length} file(s)`);
if (userMessage) console.log(`📝 Request: "${userMessage}"`);
if (userSessionId) console.log(`🧾 Session ID: ${userSessionId}`);
if (userRequestId) console.log(`🔁 Request ID: ${userRequestId}`);
if (userWorkspacePath) console.log(`📁 Workspace: ${userWorkspacePath}`);
console.log("=".repeat(60) + "\n");

async function runAgent(agentName, scriptPath, input, options = {}) {
  const { captureOutput = false, extraEnv = {}, timeoutMs = 130000 } = options;

  return new Promise((resolve, reject) => {
    console.log(`\n${"▶".repeat(3)} Running ${agentName}...`);
    console.log(`   Script: ${path.basename(scriptPath)}`);
    console.log(
      `   Input: "${String(input).substring(0, 50)}${
        String(input).length > 50 ? "..." : ""
      }"`
    );
    console.log("-".repeat(60));

    const startTime = Date.now();
    let collectedOutput = "";

    const child = spawn("node", [scriptPath, input], {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        FORCE_COLOR: "1",
        USER_SESSION_ID: userSessionId,
        USER_REQUEST_ID: userRequestId,
        USER_MESSAGE: userMessage,
        USER_AUDIO_PATH: userAudioPath,
        USER_ATTACHMENT_PATHS: JSON.stringify(userAttachmentPaths),
        // [KODO] Pass workspace path to every sub-agent so they all
        // write files to the correct VS Code project folder
        WORKSPACE_PATH: userWorkspacePath,
        // 🔑 User's stored API credentials
        USER_API_KEY: userApiKey,
        USER_BASE_URL: userBaseUrl,
        USER_MODEL: userModel,
        ...extraEnv,
      },
    });

    child.stdout.on("data", (data) => {
      const text = data.toString();
      process.stdout.write(text);
      if (captureOutput) collectedOutput += text;
    });

    child.stderr.on("data", (data) => {
      process.stderr.write(data);
    });

    child.on("close", (code) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log("-".repeat(60));

      if (code === 0) {
        console.log(`✅ ${agentName} completed successfully (${elapsed}s)\n`);
        resolve(captureOutput ? collectedOutput.trim() : "");
      } else {
        console.error(
          `❌ ${agentName} failed with exit code ${code} (${elapsed}s)\n`
        );
        reject(new Error(`${agentName} exited with code ${code}`));
      }
    });

    child.on("error", (error) => {
      console.error(`❌ ${agentName} spawn error:`, error.message);
      reject(error);
    });

    const timeout = setTimeout(() => {
      console.error(`⏱️  ${agentName} timeout - killing process...`);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5000);
      reject(new Error(`${agentName} timed out after ${Math.round(timeoutMs / 60000)} minutes`));
    }, timeoutMs);

    child.on("close", () => {
      clearTimeout(timeout);
    });
  });
}

async function main() {
  try {
    let finalMessage = userMessage;

    if (userAudioPath) {
      const whisperScript = path.resolve(__dirname, "whisper_agent.mjs");
      const whisperOutput = await runAgent(
        "Whisper Agent",
        whisperScript,
        userAudioPath,
        { captureOutput: true }
      );

      const transcript = extractSingleTextOutput(whisperOutput);
      if (transcript) {
        finalMessage = transcript;
        console.log(`🗣️ Whisper transcript: "${finalMessage}"\n`);
      }
    }

    let fileAnalysisText = "";

    if (userAttachmentPaths.length > 0) {
      const fileAgentScript = path.resolve(__dirname, "file_agent.mjs");
      const fileAgentInput = JSON.stringify({
        files: userAttachmentPaths,
        userMessage: finalMessage,
      });

      const fileAgentOutput = await runAgent(
        "File Agent",
        fileAgentScript,
        fileAgentInput,
        { captureOutput: true }
      );

      fileAnalysisText = extractFileAnalysisOutput(fileAgentOutput);

      if (fileAnalysisText) {
        console.log("\n🧩 Uploaded file analysis is ready.\n");
      }
    }

    const plannerScript = path.resolve(__dirname, "planner_agent.mjs");
    const plannerInput = [
      finalMessage || "Please analyze the uploaded files.",
      fileAnalysisText ? `Uploaded file analysis:\n${fileAnalysisText}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    await runAgent("Planner Agent", plannerScript, plannerInput, {
      extraEnv: {
        USER_FILE_ANALYSIS: fileAnalysisText,
      },
    });

    const codegenScript = path.resolve(__dirname, "codegen_agent.mjs");
    await runAgent("Codegen Agent", codegenScript, finalMessage, { timeoutMs: 300000 });

    console.log("\n🎉 Pipeline finished successfully.\n");
    process.exit(0);
  } catch (error) {
    console.error("\n💥 Pipeline failed:", error.message);
    process.exit(1);
  }
}

if (import.meta.url === `file://${__filename}`) {
  main();
}
