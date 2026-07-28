// utils/process.util.mjs
// Shared by agent_loop.mjs (background bash tasks) and mcpClient.mjs (MCP
// server subprocesses) — any child process kodo spawns should inherit the
// environment minus secrets, not the raw process.env.
export function sanitizedChildEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/(_KEY|API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|AUTH)/i.test(k)) continue;
    out[k] = v;
  }
  out.CI = "1";
  out.FORCE_COLOR = "0";
  return out;
}
