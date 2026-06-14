import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const userMessage = process.env.USER_MESSAGE || process.argv.slice(2).join(" ");
const userAudioPath = process.env.USER_AUDIO_PATH || ""; // if voice exists
const userSessionId = process.env.USER_SESSION_ID || "";
const userRequestId =
  process.env.USER_REQUEST_ID ||
  `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

if (!userMessage && !userAudioPath) {
  console.error("Usage: node pipeline_agent.mjs <your request>");
  console.error('   or: USER_MESSAGE="your request" node pipeline_agent.mjs');
  console.error('   or: USER_AUDIO_PATH="/path/to/audio.mp3" node pipeline_agent.mjs');
  process.exit(1);
}

console.log("🚀 Starting Pipeline...\n");
if (userAudioPath) {
  console.log(`🎙️  Audio: "${userAudioPath}"`);
}
if (userMessage) {
  console.log(`📝 Request: "${userMessage}"`);
}
if (userSessionId) console.log(`🧾 Session ID: ${userSessionId}`);
if (userRequestId) console.log(`🔁 Request ID: ${userRequestId}`);
console.log("=".repeat(60) + "\n");

async function runAgent(agentName, scriptPath, input) {
  return new Promise((resolve, reject) => {
    console.log(`\n${"▶".repeat(3)} Running ${agentName}...`);
    console.log(`   Script: ${path.basename(scriptPath)}`);
    console.log(
      `   Input: "${String(input).substring(0, 50)}${String(input).length > 50 ? "..." : ""}"`
    );
    console.log("-".repeat(60));

    const startTime = Date.now();

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
      },
    });

    child.stdout.on("data", (data) => {
      process.stdout.write(data);
    });

    child.stderr.on("data", (data) => {
      process.stderr.write(data);
    });

    child.on("close", (code) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

      console.log("-".repeat(60));

      if (code === 0) {
        console.log(`✅ ${agentName} completed successfully (${elapsed}s)\n`);
        resolve();
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
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 5000);

      reject(new Error(`${agentName} timed out after 2 minutes`));
    }, 130000);

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
      const result = await runAgent("Whisper Agent", whisperScript, userAudioPath);

      // Whisper agent should print the transcript to stdout or write a file.
      // Best is to return it via stdout in a single line JSON or plain text.
      finalMessage = result || userMessage;
    }

    if (!finalMessage) {
      throw new Error("No text message available after whisper transcription.");
    }

    const plannerScript = path.resolve(__dirname, "planner_agent.mjs");
    await runAgent("Planner Agent", plannerScript, finalMessage);

    const codegenScript = path.resolve(__dirname, "codegen_agent.mjs");
    await runAgent("Codegen Agent", codegenScript, finalMessage);

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