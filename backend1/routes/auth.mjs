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

const JWT_SECRET = process.env.JWT_SECRET || "kodo-local-dev-secret";
const SESSIONS_DIR = path.join(os.homedir(), ".kodo", "sessions");

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
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(workspaceTokenFile(workspacePath), JSON.stringify({ token, sessionId, workspacePath }), "utf-8");
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

    db.prepare(
      "UPDATE auth_sessions SET workspace_path = ?, workspace_name = ? WHERE id = ?"
    ).run(workspacePath, workspaceName || path.basename(workspacePath), payload.sessionId);

    writeWorkspaceTokenFile(workspacePath, token, sessionId);
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
