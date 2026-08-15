/**
 * cliUiAuthHandoff.test.mjs — the browser session `kodo ui start` hands over.
 *
 * Regression test for a shipped bug that every other suite missed. The CLI
 * printed a URL carrying `#token=<the UI service's lifecycle token>` — a random
 * string that was never a JWT and never in auth_sessions. So a freshly
 * installed Kodo opened on "Please sign in", every authenticated call answered
 * 401, and /api/workspace answered "No project connected yet" while the CLI was
 * printing the very workspace it had just started for.
 *
 * It survived because the package test authenticated with a session IT created
 * by signing up — never the credential a user is actually handed. These tests
 * assert on the CLI's own handoff channel instead.
 *
 * They also pin two security properties the handoff now rests on:
 *   • the signing key is per-installation, not a constant shipped in the tarball
 *   • /api/auth/handshake needs POSSESSION of a session, not just a valid
 *     signature, before it will repoint that session's workspace
 *
 * Real server processes over HTTP. Nothing here is mocked.
 */

import assert from "assert";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(REPO, "server.mjs");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (err) { console.log(`  ❌ ${name}\n     ${err.message}`); failed++; }
}

// A private HOME: the handshake files and the signing key both live under it,
// and a test must never read or rewrite the developer's real ones.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodo-handoff-"));
const HOME = path.join(tmp, "home");
fs.mkdirSync(HOME, { recursive: true });
const started = [];

function project(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function startApi(workspace) {
  const port = 9200 + started.length;
  const child = spawn(process.execPath, [SERVER], {
    cwd: REPO,
    env: {
      ...process.env,
      HOME,
      USERPROFILE: HOME,               // same intent on Windows
      JWT_SECRET: "",                  // force the generated per-install key
      WORKSPACE_PATH: workspace,
      KODO_HOST: "127.0.0.1",
      PORT: String(port),
      KODO_PORT: String(port),
      KODO_DB_PATH: path.join(tmp, `db-${started.length}.sqlite`),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  started.push(child);

  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return { origin };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`API for ${workspace} did not become healthy on ${port}`);
}

/** The CLI's side of the handoff: read the token the server published. */
function handshakeFile(workspace) {
  const key = crypto.createHash("sha256").update(workspace).digest("hex").slice(0, 24);
  return path.join(HOME, ".kodo", "sessions", `${key}.json`);
}
const readHandoffToken = (workspace) =>
  JSON.parse(fs.readFileSync(handshakeFile(workspace), "utf-8")).token;

const get = (origin, route, token) =>
  fetch(`${origin}${route}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(15_000),
  });

console.log("\n📦 CLI → UI auth handoff\n");

const workspace = project("handoff-project");
const api = await startApi(workspace);

await test("`kodo ui start` publishes a session token for the browser", async () => {
  assert.ok(fs.existsSync(handshakeFile(workspace)), "no handshake file was written");
  assert.ok(readHandoffToken(workspace), "handshake file carries no token");
});

await test("the handoff file is not readable by other accounts", () => {
  if (process.platform === "win32") return;  // POSIX bits do not apply
  const mode = fs.statSync(handshakeFile(workspace)).mode & 0o777;
  assert.strictEqual(mode, 0o600, `mode was ${mode.toString(8)} — the file IS the credential`);
});

await test("the published token authenticates against the API", async () => {
  const res = await get(api.origin, "/api/settings/capabilities", readHandoffToken(workspace));
  assert.strictEqual(res.status, 200, `got ${res.status} — this is the 401 the bug produced`);
});

await test("the published token resolves the workspace the CLI started for", async () => {
  const body = await (await get(api.origin, "/api/workspace", readHandoffToken(workspace))).json();
  assert.strictEqual(body.ok, true, `got ${JSON.stringify(body).slice(0, 200)}`);
  assert.strictEqual(fs.realpathSync(body.workspace), fs.realpathSync(workspace));
});

await test("an unauthenticated caller still gets no workspace", async () => {
  const body = await (await get(api.origin, "/api/workspace")).json();
  assert.strictEqual(body.ok, false, "the loopback port must not serve the project unauthenticated");
});

await test("a token the server never issued is refused", async () => {
  const res = await get(api.origin, "/api/settings/capabilities", "not-a-real-token");
  assert.strictEqual(res.status, 401);
});

console.log("\n📦 handoff security\n");

await test("the signing key is per-installation, not the constant that shipped", async () => {
  // Aimed at /api/auth/me deliberately. It authenticates through getAuthUser,
  // which VERIFIES the signature and then loads the session — so the signature
  // is genuinely what is under test here. (Routes like /api/settings/capabilities
  // match the raw token string against auth_sessions instead and would reject a
  // forgery whatever key signed it, proving nothing about the key.)
  //
  // The forged token names the session that really exists, so the session lookup
  // cannot be what rejects it. Signed with the constant the source used to fall
  // back to: on the old code this was accepted as that session.
  const real = JSON.parse(fs.readFileSync(handshakeFile(workspace), "utf-8"));
  const forged = jwt.sign({ userId: 1, sessionId: real.sessionId }, "kodo-local-dev-secret");
  const res = await get(api.origin, "/api/auth/me", forged);
  assert.strictEqual(res.status, 401, "a token signed with the published constant was ACCEPTED");
});

await test("handshake refuses to repoint a session the caller does not hold", async () => {
  // Read the real session id, then present a correctly-shaped token for it that
  // is NOT that session's token. Signature validity alone must not be enough.
  const real = JSON.parse(fs.readFileSync(handshakeFile(workspace), "utf-8"));
  // Whatever key this build signs with — the generated one, or the old constant
  // if the per-install key is ever regressed away. The point of this test is the
  // POSSESSION check, so it must not fail merely because the key moved.
  let secret;
  try {
    secret = fs.readFileSync(path.join(HOME, ".kodo", "jwt-secret"), "utf-8").trim();
  } catch {
    secret = "kodo-local-dev-secret";
  }
  const forged = jwt.sign({ userId: 1, sessionId: real.sessionId }, secret);

  const res = await fetch(`${api.origin}/api/auth/handshake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: forged,
      sessionId: real.sessionId,
      workspacePath: "/tmp/attacker-chosen",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.strictEqual(res.status, 401, "a forged token repointed someone else's workspace");

  // …and the real session must be untouched.
  const body = await (await get(api.origin, "/api/workspace", real.token)).json();
  assert.strictEqual(fs.realpathSync(body.workspace), fs.realpathSync(workspace),
    "the workspace was rebound by a caller that did not hold the session");
});

await test("one session's token cannot repoint ANOTHER session", async () => {
  // Two genuine sessions, both legitimately issued. Holding a valid token for
  // session A must not confer authority over session B — otherwise any signed-in
  // client could walk other sessions onto a directory of its choosing.
  const a = JSON.parse(fs.readFileSync(handshakeFile(workspace), "utf-8"));

  const signup = await fetch(`${api.origin}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `b-${Date.now()}@example.test`, password: "secret123", name: "B" }),
  });
  const b = await signup.json();
  assert.ok(b.token && b.sessionId, `could not create a second session: ${JSON.stringify(b).slice(0, 150)}`);

  // Token A, naming session B.
  const res = await fetch(`${api.origin}/api/auth/handshake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: a.token, sessionId: b.sessionId, workspacePath: "/tmp/attacker-chosen" }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.strictEqual(res.status, 401, "token A repointed session B");

  // Session B must still resolve whatever it resolved before, not the attacker path.
  const after = await (await get(api.origin, "/api/workspace", b.token)).json();
  if (after.ok) {
    assert.notStrictEqual(after.workspace, "/tmp/attacker-chosen", "session B was rebound");
  }
});

await test("handshake still works for the session's real token", async () => {
  const real = JSON.parse(fs.readFileSync(handshakeFile(workspace), "utf-8"));
  const res = await fetch(`${api.origin}/api/auth/handshake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: real.token,
      sessionId: real.sessionId,
      workspacePath: workspace,
      workspaceName: path.basename(workspace),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.strictEqual(res.status, 200, "the legitimate VS Code handshake must keep working");
});

for (const child of started) { try { child.kill("SIGKILL"); } catch {} }
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
