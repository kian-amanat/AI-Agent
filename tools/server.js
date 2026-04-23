// tools/server.js
import { spawn } from "child_process";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Strategy:
 *   - NEVER spawn node + npm-cli.js (this triggers ENOENT on macOS + NVM)
 *   - Always spawn "npm" via shell:true so that NVM shims work
 *   - Add robust logging, retries, health checks
 */
export function startDevServer({
  appDir,
  port = 5173,
  script = "dev",       // "dev" or "start"
  extraArgs = [],
}) {
  const fullPath = path.resolve(__dirname, "..", "workspace", appDir);

  console.log(`\n────────────────────────────────────────────`);
  console.log(`[server] 🚀 Starting dev server`);
  console.log(`[server] 📂 Directory: ${fullPath}`);
  console.log(`[server] 🌐 Port:      ${port}`);
  console.log(`[server] 📜 Script:    npm run ${script}`);
  console.log(`────────────────────────────────────────────\n`);

  if (!fs.existsSync(fullPath)) {
    console.error(`[server] ❌ ERROR: App directory does not exist:\n${fullPath}`);
    return null;
  }

const args = [
  "run",
  script,
  "--",
  "--port",
  String(port)
];


  console.log(`[server] 🔧 Executing: npm ${args.join(" ")}`);
  console.log(`[server] 🐚 Spawn method: shell=true (NVM‑compatible)`);

  const proc = spawn("npm", args, {
    cwd: fullPath,
    shell: true,          // ❤️ KEY FIX: macOS + NVM compatibility
    stdio: "inherit",
    env: {
      ...process.env,
      FORCE_COLOR: "1",
    }
  });

  proc.on("error", (err) => {
    console.error("[server] ❌ Failed to start dev server:", err);
  });

  proc.on("exit", (code) => {
    if (code !== 0) {
      console.error(`[server] ⚠ Dev server exited with code ${code}`);
    } else {
      console.log(`[server] 🟦 Dev server exited normally`);
    }
  });

  return { proc };
}

/**
 * Smart health‑check with retry
 */
export function waitForServer(url, timeout = 30000) {
  console.log(`[server] 🕒 Waiting for server: ${url}`);

  const start = Date.now();

  return new Promise((resolve, reject) => {
    function probe() {
      http
        .get(url, () => {
          console.log("[server] ✅ Dev server is LIVE!\n");
          resolve(true);
        })
        .on("error", () => {
          const elapsed = Date.now() - start;
          if (elapsed > timeout) {
            reject(new Error("[server] ❌ Timeout waiting for dev server."));
          } else {
            setTimeout(probe, 700);
          }
        });
    }
    probe();
  });
}

/**
 * Clean shutdown
 */
export function stopDevServer(proc) {
  if (!proc) return;

  console.log("[server] 🛑 Stopping dev server...");
  try {
    proc.kill("SIGTERM");
    console.log("[server] ✔ Dev server stopped");
  } catch (err) {
    console.error("[server] ❌ Failed to stop dev server:", err);
  }
}
