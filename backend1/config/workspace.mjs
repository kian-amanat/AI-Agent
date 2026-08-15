/**
 * config/workspace.mjs — how a request finds out which project it operates on.
 *
 * Kodo has TWO ways a workspace gets chosen, and they must converge here rather
 * than each growing their own resolution logic:
 *
 *   VS Code   extension → POST /api/auth/{login,signup,workspace,handshake}
 *                       → auth_sessions.workspace_path   (per auth session)
 *
 *   CLI       `kodo ui start` in /path/to/project
 *                       → WORKSPACE_PATH in the API process environment
 *                       → CLI_WORKSPACE                  (per SERVER process)
 *
 * The session-bound path always wins. It is more specific — a VS Code user with
 * three windows open has three sessions against one backend, and the server
 * process cannot know which project a given request came from.
 *
 * ── Why the CLI fallback is safe, and why it is conditional ─────────────────
 *
 * Routes used to refuse outright when a session had no bound workspace, because
 * defaulting to the server's own directory is a real leak when several accounts
 * share one backend: the file tree would expose whatever project the server was
 * launched from, and the agent WRITES files, so an unconfigured user would be
 * editing someone else's project.
 *
 * That reasoning holds exactly as long as the server's directory is incidental.
 * When the CLI starts the API it is not incidental — the operator typed
 * `kodo ui start` in that directory, on their own machine, bound to loopback,
 * as themselves. Refusing there is not a safety property, it is the bug this
 * module fixes: it forced a CLI user to install VS Code to use the CLI.
 *
 * So the fallback is gated on WORKSPACE_PATH being set EXPLICITLY. A hosted or
 * multi-user deployment does not set it, gets `null`, and behaves exactly as
 * before. Nothing widens for the deployment shape the original comment was
 * protecting.
 */

import fs from "fs";
import path from "path";

/**
 * The workspace this server process was started for, or null.
 *
 * Read ONCE at import. The workspace chosen at startup is authoritative for the
 * life of the process — re-reading the environment later would let anything
 * that can set a variable in this process retarget every unbound session.
 *
 * Validated as a real directory: a typo'd --cwd should not silently become a
 * workspace that no route can read.
 */
export const CLI_WORKSPACE = (() => {
  const raw = process.env.WORKSPACE_PATH;
  if (!raw || !String(raw).trim()) return null;
  try {
    const abs = path.resolve(String(raw).trim());
    return fs.statSync(abs).isDirectory() ? abs : null;
  } catch {
    return null;
  }
})();

/**
 * The workspace for a request, or null when there is genuinely none.
 *
 * Callers MUST still handle null — it means no project is connected and the
 * request cannot proceed. This never falls back to `process.cwd()`: the API
 * runs with cwd=backend1, so that fallback silently pointed the agent at
 * Kodo's own source tree.
 */
export function resolveWorkspace(authSession) {
  const bound = authSession?.workspace_path;
  if (bound && String(bound).trim()) return String(bound).trim();
  return CLI_WORKSPACE;
}

/** How the workspace was chosen — for GET /api/workspace and for diagnostics. */
export function workspaceSource(authSession) {
  const bound = authSession?.workspace_path;
  if (bound && String(bound).trim()) return "session";
  return CLI_WORKSPACE ? "cli" : "none";
}
