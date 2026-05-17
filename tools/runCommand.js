// tools/run_command.js
import { spawn } from "child_process";
import { resolveWorkspacePath, WORKSPACE_ROOT } from "./workspace_utils.js";

/**
 * Safe & correct runCommand implementation
 * - No shell
 * - Proper argv splitting
 * - True execution of absolute npm/npx paths
 * - Guaranteed cwd resolution
 */
export async function runCommand({ cmd, cwd, timeout_ms, __json_error__ }) {
  return new Promise((resolve) => {
    try {
      if (__json_error__) {
        return resolve({
          success: false,
          error: `Invalid JSON for runCommand: ${String(__json_error__)}`,
          stdout: "",
          stderr: "",
        });
      }

      if (!cmd || typeof cmd !== "string") {
        return resolve({
          success: false,
          error: "'cmd' must be a non-empty string",
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
      // Split command into [bin, ...args]
      // -----------------------------
      const parts = cmd.split(" ").filter(Boolean);
      const bin = parts.shift();
      const args = parts;

      // -----------------------------
      // Spawn (WITHOUT shell)
      // -----------------------------
      const proc = spawn(bin, args, {
        cwd: execCwd,
        shell: false,               // <-- FIXED (most important)
        env: {
          ...process.env,
          PATH: process.env.PATH,   // inherited correctly
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
          error: code === 0 ? "" : `Exited with code ${code}`,
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
