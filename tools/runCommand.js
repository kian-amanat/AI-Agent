// tools/run_command.js
import { spawn } from "child_process";
import { resolveWorkspacePath, WORKSPACE_ROOT } from "./workspace_utils.js";

/**
 * Unified runCommand
 * Supports both:
 *   - runCommand({ cmd: "npm install --include=dev", cwd: "..." })
 *   - runCommand({ command: "/abs/path/to/npm", args: ["install", "--include=dev"], cwd: "..." })
 */
export async function runCommand(options) {
  return new Promise((resolve) => {
    try {
      const { cmd, command, args, cwd, timeout_ms, __json_error__ } = options || {};

      if (__json_error__) {
        return resolve({
          success: false,
          error: `Invalid JSON for runCommand: ${String(__json_error__)}`,
          stdout: "",
          stderr: "",
        });
      }

      // -----------------------------
      // Resolve working directory
      // -----------------------------
      let execCwd = WORKSPACE_ROOT;
      if (cwd && cwd.trim() !== "") {
        const { fullPath } = resolveWorkspacePath(cwd);
        execCwd = fullPath;
      }

      // -----------------------------
      // Determine bin + argv
      // -----------------------------
      let bin;
      let argv;

      if (command) {
        // New API: explicit command + args
        bin = command;
        argv = Array.isArray(args) ? args : [];
      } else if (cmd && typeof cmd === "string") {
        // Legacy API: cmd string, split on spaces
        const parts = cmd.split(" ").filter(Boolean);
        bin = parts.shift();
        argv = parts;
      } else {
        return resolve({
          success: false,
          error: "runCommand: either 'command' or non-empty 'cmd' string is required",
          stdout: "",
          stderr: "",
        });
      }

      // -----------------------------
      // Spawn (WITHOUT shell)
      // -----------------------------
      const proc = spawn(bin, argv, {
        cwd: execCwd,
        shell: false,
        env: {
          ...process.env,
          PATH: process.env.PATH, // می‌تونیم بعداً این‌جا REAL_NPM_PATH هم prepend کنیم
        },
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (d) => (stdout += d.toString()));
      proc.stderr.on("data", (d) => (stderr += d.toString()));

      let timeoutId = null;
      if (timeout_ms && Number.isFinite(timeout_ms)) {
        timeoutId = setTimeout(() => {
          proc.kill("SIGKILL");
          resolve({
            success: false,
            error: `Timeout after ${timeout_ms}ms`,
            stdout,
            stderr,
          });
        }, timeout_ms);
      }

      proc.on("close", (code) => {
        if (timeoutId) clearTimeout(timeoutId);
        resolve({
          success: code === 0,
          error: code === 0 ? "" : `Exited with code ${code}\n${stderr}`,
          stdout,
          stderr,
        });
      });
    } catch (err) {
      resolve({
        success: false,
        error: "runCommand crashed: " + err.message,
        stdout: "",
        stderr: "",
      });
    }
  });
}
