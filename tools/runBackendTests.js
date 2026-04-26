// tools/runBackendTests.js
import { runBackendCommand } from "./run_backend_command.js";

const BACKEND_CWD = "backend"; // نسبی نسبت به ریشه پروژه

export async function runBackendTests({
  cmd = "npm test",
  cwd = BACKEND_CWD,
  timeout_ms = 5 * 60 * 1000,
} = {}) {
  const result = await runBackendCommand({
    cmd,
    cwd,
    timeout_ms,
  });

  return {
    success: result.success,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? "",
  };
}
