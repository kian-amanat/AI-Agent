// backend1/routes/auth.mjs
// Register in server.mjs with:
//   import authRoute from "./routes/auth.mjs";
//   await fastify.register(authRoute, { prefix: "/api/auth" });

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import db from "../db.mjs";

const SESSIONS_DIR = path.join(os.homedir(), ".kodo", "sessions");
const SECRET_FILE = path.join(os.homedir(), ".kodo", "jwt-secret");

/**
 * The signing key for this INSTALLATION.
 *
 * This used to fall back to a hardcoded literal. Nothing ever set the variable,
 * so every copy of Kodo on every machine signed with the same publicly-known
 * key — the constant shipped inside the npm tarball. Anyone able to reach the
 * loopback port could then mint a token this server would accept as genuine,
 * which is the whole authentication story for the CLI→UI handoff.
 *
 * Generated once, persisted 0600, and reused so sessions survive a restart.
 * An explicit JWT_SECRET still wins, for deployments that manage their own.
 */
function resolveJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  try {
    const existing = fs.readFileSync(SECRET_FILE, "utf-8").trim();
    if (existing) return existing;
  } catch { /* first run, or an unreadable home — fall through and create one */ }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(SECRET_FILE, generated, { encoding: "utf-8", mode: 0o600 });
  } catch {
    // Read-only or absent HOME: keep a process-lifetime secret. Sessions then
    // do not survive a restart — worse to use, but never a shared constant.
  }
  return generated;
}

const JWT_SECRET = resolveJwtSecret();

// ─── Helpers ─────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function signToken(userId, sessionId) {
  return jwt.sign({ userId, sessionId }, JWT_SECRET, { expiresIn: "30d" });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// The handshake file used to be a single machine-wide `~/.kodo/token.json` —
// ANY extension window on the machine read the SAME file regardless of which
// project/file it had open, so opening a different project silently logged
// in as whoever last logged in anywhere. Scoping the file by a hash of the
// workspace path means a different project simply has no file yet, and the
// extension correctly falls through to its own login prompt — no cross-project
// identity bleed, and no code change needed in the extension itself as long as
// it keys its lookup off the same workspace path it already knows.
function workspaceTokenFile(workspacePath) {
  const key = crypto.createHash("sha256").update(String(workspacePath || "")).digest("hex").slice(0, 24);
  return path.join(SESSIONS_DIR, `${key}.json`);
}

function writeWorkspaceTokenFile(workspacePath, token, sessionId) {
  if (!workspacePath) return;
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  // 0600: the file IS the credential. Default umask would leave it readable by
  // every account on a shared machine.
  fs.writeFileSync(workspaceTokenFile(workspacePath), JSON.stringify({ token, sessionId, workspacePath }), { encoding: "utf-8", mode: 0o600 });
}

/** Read back a handshake file — the CLI's side of the same channel. */
export function readWorkspaceTokenFile(workspacePath) {
  try {
    return JSON.parse(fs.readFileSync(workspaceTokenFile(workspacePath), "utf-8"));
  } catch {
    return null;
  }
}

// The account CLI sessions belong to. Local, password-less by construction (the
// hash is random and never disclosed, so no one can log in AS it through
// /login) — it exists only to satisfy the users FK and to keep CLI sessions
// inside the ONE session contract every other route already enforces.
const CLI_USER_EMAIL = "cli@kodo.local";

function ensureCliUser() {
  const found = db.prepare("SELECT id FROM users WHERE email = ?").get(CLI_USER_EMAIL);
  if (found) return found.id;
  const unusable = bcrypt.hashSync(crypto.randomBytes(32).toString("hex"), 10);
  return db
    .prepare("INSERT INTO users (email, password, name) VALUES (?, ?, ?)")
    .run(CLI_USER_EMAIL, unusable, "Kodo CLI").lastInsertRowid;
}

/**
 * Give `kodo ui start` a real authenticated session bound to its workspace.
 *
 * The CLI used to hand the browser the UI SERVICE's lifecycle token — a random
 * string the API had never heard of, in no session table and not even a JWT. So
 * every authenticated route the freshly-opened UI called answered 401, and
 * /api/workspace answered "No project connected yet" while the CLI was printing
 * the very workspace it had started for. That is the CLI-first flow failing at
 * the last inch.
 *
 * The fix is to issue the browser a session that is genuinely authentic rather
 * than to teach the routes to trust something that is not. This mints the same
 * JWT + auth_sessions row that login and the extension handshake produce — same
 * store, same validation, no bypass route — and publishes it through the
 * existing per-workspace handshake file, which the CLI reads to build the URL.
 *
 * Called ONLY with an explicitly-set WORKSPACE_PATH (see config/workspace.mjs),
 * so a hosted or multi-user deployment never provisions one. The session is
 * bound to that workspace at creation, so this token cannot reach another
 * project even though it was created without a password.
 */
export function provisionCliSession(workspacePath) {
  if (!workspacePath) return null;

  // Reuse the workspace's existing session while its JWT is still valid, so
  // restarting the server does not invalidate a browser tab that is open.
  const existing = db
    .prepare("SELECT id, token FROM auth_sessions WHERE workspace_path = ? ORDER BY last_active DESC")
    .get(workspacePath);
  if (existing && verifyToken(existing.token)) {
    writeWorkspaceTokenFile(workspacePath, existing.token, existing.id);
    return { token: existing.token, sessionId: existing.id };
  }

  const userId = ensureCliUser();
  const sessionId = generateId("sess");
  const token = signToken(userId, sessionId);
  db.prepare(
    "INSERT INTO auth_sessions (id, user_id, token, workspace_path, workspace_name, created_at, last_active) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(sessionId, userId, token, workspacePath, path.basename(workspacePath), nowIso(), nowIso());

  writeWorkspaceTokenFile(workspacePath, token, sessionId);
  return { token, sessionId };
}

function clearWorkspaceTokenFile(workspacePath) {
  if (!workspacePath) return;
  try {
    const f = workspaceTokenFile(workspacePath);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch {}
}

// ─── Auth decorator (reusable inside this plugin) ─────────────────

function getAuthUser(request) {
  const auth = request.headers["authorization"];
  if (!auth?.startsWith("Bearer ")) return null;

  const payload = verifyToken(auth.slice(7));
  if (!payload) return null;

  const session = db
    .prepare("SELECT * FROM auth_sessions WHERE id = ?")
    .get(payload.sessionId);
  if (!session) return null;

  // touch last_active
  db.prepare("UPDATE auth_sessions SET last_active = ? WHERE id = ?").run(
    nowIso(),
    payload.sessionId
  );

  const user = db
    .prepare("SELECT id, email, name, plan, created_at FROM users WHERE id = ?")
    .get(payload.userId);

  return { user, session };
}

// ─── Plugin ──────────────────────────────────────────────────────

export default async function authRoute(fastify) {
  // POST /api/auth/signup
  fastify.post("/signup", async (request, reply) => {
    const { email, password, name, workspacePath, workspaceName } = request.body ?? {};

    if (!email || !password || !name) {
      return reply
        .code(400)
        .send({ ok: false, error: "email, password and name are required" });
    }
    if (password.length < 6) {
      return reply
        .code(400)
        .send({ ok: false, error: "Password must be at least 6 characters" });
    }

    const existing = db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(email);
    if (existing) {
      return reply
        .code(409)
        .send({ ok: false, error: "Email already registered" });
    }

    const hashed = await bcrypt.hash(password, 10);
    const result = db
      .prepare("INSERT INTO users (email, password, name) VALUES (?, ?, ?)")
      .run(email, hashed, name);

    const userId = result.lastInsertRowid;
    const sessionId = generateId("sess");
    const token = signToken(userId, sessionId);

    // Bind the workspace AT creation time when the caller already knows it
    // (e.g. the extension handoff, which knows exactly which file/project is
    // open) — never left to a best-effort follow-up call that might not happen.
    db.prepare(
      "INSERT INTO auth_sessions (id, user_id, token, workspace_path, workspace_name, created_at, last_active) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(sessionId, userId, token, workspacePath || null, workspaceName || (workspacePath ? path.basename(workspacePath) : null), nowIso(), nowIso());

    if (workspacePath) writeWorkspaceTokenFile(workspacePath, token, sessionId);

    const user = db
      .prepare(
        "SELECT id, email, name, plan, created_at FROM users WHERE id = ?"
      )
      .get(userId);

    return { ok: true, token, sessionId, user };
  });

  // POST /api/auth/login
  fastify.post("/login", async (request, reply) => {
    const { email, password, workspacePath, workspaceName } = request.body ?? {};

    if (!email || !password) {
      return reply
        .code(400)
        .send({ ok: false, error: "email and password are required" });
    }

    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user) {
      return reply
        .code(401)
        .send({ ok: false, error: "Invalid email or password" });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return reply
        .code(401)
        .send({ ok: false, error: "Invalid email or password" });
    }

    const sessionId = generateId("sess");
    const token = signToken(user.id, sessionId);

    db.prepare(
      "INSERT INTO auth_sessions (id, user_id, token, workspace_path, workspace_name, created_at, last_active) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(sessionId, user.id, token, workspacePath || null, workspaceName || (workspacePath ? path.basename(workspacePath) : null), nowIso(), nowIso());

    if (workspacePath) writeWorkspaceTokenFile(workspacePath, token, sessionId);

    return {
      ok: true,
      token,
      sessionId,
      user: { id: user.id, email: user.email, name: user.name, plan: user.plan },
    };
  });

  // POST /api/auth/logout
  fastify.post("/logout", async (request, reply) => {
    const auth = getAuthUser(request);
    if (auth) {
      db.prepare("DELETE FROM auth_sessions WHERE id = ?").run(
        auth.session.id
      );
      clearWorkspaceTokenFile(auth.session.workspace_path);
    }
    return { ok: true };
  });

  // GET /api/auth/me
  fastify.get("/me", async (request, reply) => {
    const auth = getAuthUser(request);
    if (!auth) return reply.code(401).send({ ok: false, error: "Unauthorized" });

    return { ok: true, user: auth.user, session: auth.session };
  });

  // POST /api/auth/workspace  — extension calls this after login to bind its workspace path
  fastify.post("/workspace", async (request, reply) => {
    const auth = getAuthUser(request);
    if (!auth) return reply.code(401).send({ ok: false, error: "Unauthorized" });

    const { workspacePath, workspaceName } = request.body ?? {};
    if (!workspacePath) {
      return reply
        .code(400)
        .send({ ok: false, error: "workspacePath is required" });
    }

    db.prepare(
      "UPDATE auth_sessions SET workspace_path = ?, workspace_name = ? WHERE id = ?"
    ).run(
      workspacePath,
      workspaceName || path.basename(workspacePath),
      auth.session.id
    );

    return { ok: true, workspacePath, workspaceName };
  });

  // POST /api/auth/handshake
  // Called by the web UI after login so the extension can detect the token via
  // file polling. workspacePath is REQUIRED — this is what scopes the handshake
  // file to one project instead of the whole machine (see workspaceTokenFile
  // above). A caller that can't supply it can't safely hand off a session.
  fastify.post("/handshake", async (request, reply) => {
    const { token, sessionId, workspacePath, workspaceName } = request.body ?? {};
    if (!token || !sessionId) {
      return reply
        .code(400)
        .send({ ok: false, error: "token and sessionId required" });
    }
    if (!workspacePath) {
      return reply
        .code(400)
        .send({ ok: false, error: "workspacePath is required — the handshake must be scoped to the project that's actually open" });
    }

    const payload = verifyToken(token);
    if (!payload) {
      return reply.code(401).send({ ok: false, error: "Invalid token" });
    }

    // A valid SIGNATURE is not proof the caller owns the session it is naming.
    // Without this check the route rebinds the workspace of whatever sessionId
    // the token claims — so anyone who could produce a signed token could point
    // somebody else's live session at a directory of their choosing, and the
    // agent would read and WRITE there. Require that the presented token IS the
    // session's current token: possession of the session, not merely knowledge
    // of how to sign.
    const session = db
      .prepare("SELECT id, token FROM auth_sessions WHERE id = ?")
      .get(payload.sessionId);
    if (!session || session.token !== token) {
      return reply.code(401).send({ ok: false, error: "Invalid token" });
    }

    // The caller also NAMES a session in the body. Only the token decides which
    // one is acted on, so a mismatch was previously ignored in silence — the
    // request said "repoint session B", the server repointed session A, and
    // answered 200. Nothing was rebound that shouldn't be, but a caller cannot
    // tell a no-op from a success. Refuse instead of quietly doing something
    // other than what was asked.
    if (sessionId !== session.id) {
      return reply
        .code(401)
        .send({ ok: false, error: "token does not belong to the named session" });
    }

    db.prepare(
      "UPDATE auth_sessions SET workspace_path = ?, workspace_name = ? WHERE id = ?"
    ).run(workspacePath, workspaceName || path.basename(workspacePath), session.id);

    writeWorkspaceTokenFile(workspacePath, token, session.id);
    return { ok: true };
  });

  // DELETE /api/auth/handshake — clear on logout from browser (scoped)
  fastify.delete("/handshake", async (request, reply) => {
    const { workspacePath } = request.body ?? {};
    clearWorkspaceTokenFile(workspacePath);
    return { ok: true };
  });
}

// ─── Export verifyToken so server.mjs can use it for other routes ─
export { verifyToken, getAuthUser };
