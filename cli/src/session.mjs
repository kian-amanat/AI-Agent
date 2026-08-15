/**
 * cli/src/session.mjs — the CLI's side of the API session handshake.
 *
 * `kodo ui start` has to hand the browser a credential the API will actually
 * accept. It cannot mint one itself: API tokens are JWTs signed with the
 * server's JWT_SECRET and recorded in auth_sessions, and the CLI has neither.
 * It used to hand over the UI service's own lifecycle token instead — a random
 * string the API had never seen — which is why a freshly-opened UI answered
 * 401 and "No project connected yet".
 *
 * So the API mints the session (routes/auth.mjs provisionCliSession) and
 * publishes it to this per-workspace file; the CLI reads it back. The file is
 * keyed by a hash of the workspace path and written 0600 by the server — the
 * SAME channel the VS Code extension already handshakes through, so there is
 * one session mechanism here, not two.
 *
 * Keep workspaceTokenFile() in step with routes/auth.mjs.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const SESSIONS_DIR = path.join(os.homedir(), ".kodo", "sessions");

function workspaceTokenFile(workspacePath) {
  const key = crypto.createHash("sha256").update(String(workspacePath || "")).digest("hex").slice(0, 24);
  return path.join(SESSIONS_DIR, `${key}.json`);
}

/**
 * The API session token for a workspace, or null when the server has not
 * published one (an API this CLI did not start, or an older server).
 *
 * Callers must handle null rather than substituting a token of their own: a
 * URL carrying a token the API will reject is worse than one carrying none,
 * because the failure surfaces as a confusing sign-in wall instead of an
 * obvious missing-session.
 */
export function readApiSessionToken(workspacePath) {
  if (!workspacePath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(workspaceTokenFile(workspacePath), "utf-8"));
    const token = typeof parsed?.token === "string" ? parsed.token.trim() : "";
    return token || null;
  } catch {
    return null;
  }
}
