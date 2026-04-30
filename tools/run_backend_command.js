// tools/run_backend_command.js
import { spawn } from "child_process";
import path from "path";

/**
 * runBackendCommand
 * نسخه‌ی ساده و ایزوله‌شده برای backend
 * - بدون workspace_utils
 * - cwd نسبی نسبت به process.cwd()
 */
export async function runBackendCommand({ cmd, cwd, timeout_ms, __json_error__ }) {
  return new Promise((resolve) => {
    try {
      if (__json_error__) {
        return resolve({
          success: false,
          error: `Invalid JSON for runBackendCommand: ${String(__json_error__)}`,
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

      // Determine working directory
      let execCwd = process.cwd();
      if (cwd && cwd.trim() !== "") {
        execCwd = path.isAbsolute(cwd) ? cwd : path.join(process.cwd(), cwd);
      }

      // ----------------------------------------------------
      // Decide if this command requires a shell
      // ----------------------------------------------------
      const mustUseShell =
        cmd.includes("=") ||    // env=key
        cmd.includes(">") ||    // redirect
        cmd.includes("|") ||    // pipes
        cmd.includes("&");      // background

      let bin, args;

      if (!mustUseShell) {
        // Regular binary + args split
        const parts = cmd.split(" ").filter(Boolean);
        bin = parts.shift();
        args = parts;
      } else {
        // Let shell interpret everything
        bin = cmd;
        args = [];
      }

      const proc = spawn(bin, args, {
        cwd: execCwd,
        shell: mustUseShell,  // <-- magic fix!!!
        env: { ...process.env },
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
        error: "runBackendCommand crashed: " + err.message,
        stdout: "",
        stderr: "",
      });
    }
  });
}

