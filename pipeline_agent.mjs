import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 🟩 ورودی اصلی از env یا argv
const userMessage = process.env.USER_MESSAGE || process.argv.slice(2).join(" ");
const userSessionId = process.env.USER_SESSION_ID || "";
const userRequestId =
  process.env.USER_REQUEST_ID ||
  `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

if (!userMessage) {
  console.error("Usage: node pipeline_agent.mjs <your request>");
  console.error('   or: USER_MESSAGE="your request" node pipeline_agent.mjs');
  process.exit(1);
}

console.log("🚀 Starting Pipeline...\n");
console.log(`📝 Request: "${userMessage}"\n`);
if (userSessionId) console.log(`🧾 Session ID: ${userSessionId}`);
if (userRequestId) console.log(`🔁 Request ID: ${userRequestId}`);
console.log("=".repeat(60) + "\n");

async function runAgent(agentName, scriptPath, input) {
  return new Promise((resolve, reject) => {
    console.log(`\n${"▶".repeat(3)} Running ${agentName}...`);
    console.log(`   Script: ${path.basename(scriptPath)}`);
    console.log(
      `   Input: "${input.substring(0, 50)}${input.length > 50 ? "..." : ""}"`
    );
    console.log("-".repeat(60));

    const startTime = Date.now();

    const child = spawn("node", [scriptPath, input], {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        FORCE_COLOR: "1",
        // 🔹 اینجا Session/Request ID را به همه‌ی agentها پاس می‌دهیم
        USER_SESSION_ID: userSessionId,
        USER_REQUEST_ID: userRequestId,
        USER_MESSAGE: userMessage,
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
      }, 130000);

      reject(new Error(`${agentName} timed out after 2 minutes`));
    }, 130000);

    child.on("close", () => {
      clearTimeout(timeout);
    });
  });
}

async function main() {
  try {
    // 🧠 ۱) Planner Agent
    const plannerScript = path.resolve(__dirname, "planner_agent.mjs");
    await runAgent("Planner Agent", plannerScript, userMessage);

    // 🧬 ۲) Codegen Agent
    const codegenScript = path.resolve(__dirname, "codegen_agent.mjs");
    await runAgent("Codegen Agent", codegenScript, userMessage);

    console.log("\n🎉 Pipeline finished successfully.\n");
    process.exit(0);
  } catch (error) {
    console.error("\n💥 Pipeline failed:", error.message);
    process.exit(1);
  }
}

// فقط وقتی مستقیم اجرا می‌شود (نه وقتی import می‌شود)
if (import.meta.url === `file://${__filename}`) {
  main();
}
