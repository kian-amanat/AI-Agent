/**
 * workspaceConnection.test.mjs — the CLI-started UI must have a workspace.
 *
 * Regression test for a shipped bug. After `npm install -g kodo-agent`, this:
 *
 *     cd my-project && kodo ui start
 *
 * started a working UI, and the first chat message came back with:
 *
 *     No project connected yet. Open Kodo from your project (via the
 *     extension) or pick one from the folder switcher before chatting.
 *
 * The workspace was only ever bound by a client that already knew the path —
 * the VS Code extension. A browser cannot know the terminal's directory, so a
 * CLI-first install had no way to connect a project at all: the CLI required
 * the editor extension to be usable.
 *
 * These tests drive a REAL server process over HTTP. They do not mock the
 * frontend, and they do not assert on a variable — they assert that the API a
 * browser actually talks to reports the workspace the CLI started it with.
 */

import assert from "assert";
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodo-ws-"));
const started = [];

function project(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  return dir;
}

/** Start a real API process for `workspace`, exactly as `kodo ui start` does. */
async function startApi(workspace) {
  const port = 9100 + started.length;
  const child = spawn(process.execPath, [SERVER], {
    cwd: REPO,
    env: {
      ...process.env,
      WORKSPACE_PATH: workspace,        // ← the entire CLI → API contract
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
      if (r.ok) return { origin, child };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`API for ${workspace} did not become healthy on ${port}`);
}

/**
 * Sign up WITHOUT a workspacePath — precisely what the CLI-launched browser UI
 * does. The extension is the only client that has a path to send, and it is not
 * involved here.
 */
async function signIn(origin, email) {
  const res = await fetch(`${origin}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "secret123", name: "CLI User" }),
  });
  const body = await res.json();
  assert.ok(body.token, `signup failed: ${JSON.stringify(body).slice(0, 200)}`);
  return body.token;
}

const get = (origin, route, token) =>
  fetch(`${origin}${route}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(15_000),
  }).then((r) => r.json());

console.log("\n📦 workspace connection (CLI-first, no VS Code)\n");

const projectA = project("kodo-project-a");
const projectB = project("kodo-project-b");

const a = await startApi(projectA);
const tokenA = await signIn(a.origin, "a@example.test");

await test("GET /api/workspace reports the workspace the CLI started the server with", async () => {
  const body = await get(a.origin, "/api/workspace", tokenA);
  assert.strictEqual(body.ok, true, `got ${JSON.stringify(body).slice(0, 200)}`);
  assert.strictEqual(body.workspace, projectA);
  assert.strictEqual(body.name, "kodo-project-a");
  assert.strictEqual(body.source, "cli", "the workspace came from the CLI, not a bound session");
});

await test("REQUIRED: sending 'hi' does NOT answer 'No project connected yet'", async () => {
  // The exact user-visible bug, against the endpoint the composer actually
  // posts to. A session that never supplied a workspacePath must not be
  // refused. Any OTHER failure (no model configured, provider error) is fine
  // here — this asserts the workspace gate specifically, nothing downstream.
  const res = await fetch(`${a.origin}/api/agent/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ message: "hi" }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();

  // Guard against this test passing because the route moved and every request
  // 404s — which is exactly how an earlier version of it passed vacuously.
  assert.notStrictEqual(res.status, 404, "POST /api/agent/run is gone — this test proves nothing");

  assert.ok(!/no_workspace/.test(text) && !/No project connected yet/.test(text),
    `the workspace gate still rejects a CLI-started session: ${text.slice(0, 300)}`);
});

await test("the file tree resolves against the CLI workspace", async () => {
  const body = await get(a.origin, "/api/workspace/files", tokenA);
  assert.strictEqual(body.ok, true, `got ${JSON.stringify(body).slice(0, 200)}`);
  assert.strictEqual(body.root, projectA);
  assert.ok(body.files.some((f) => f.path === "README.md"), "README.md should be listed");
});

await test("an UNAUTHENTICATED caller gets no workspace at all", async () => {
  // The CLI fallback decides WHICH workspace an authenticated caller gets —
  // never WHETHER an anonymous one gets it. Any local process can reach the
  // loopback port; none of them may read the project's files without a token.
  for (const route of ["/api/workspace", "/api/workspace/files", "/api/workspace/git"]) {
    const body = await get(a.origin, route, null);
    assert.strictEqual(body.ok, false, `${route} answered an unauthenticated caller`);
    assert.strictEqual(body.error, "no_workspace");
  }
});

await test("no filesystem path is exposed to an unauthenticated caller", async () => {
  const body = await get(a.origin, "/api/workspace", null);
  assert.ok(!JSON.stringify(body).includes(tmp), "the response leaked a host path");
});

// ── Workspace invariant: a second project must not inherit the first ─────────

const b = await startApi(projectB);
const tokenB = await signIn(b.origin, "b@example.test");

await test("a server started in project B reports B, never A", async () => {
  const body = await get(b.origin, "/api/workspace", tokenB);
  assert.strictEqual(body.workspace, projectB);
  assert.notStrictEqual(body.workspace, projectA, "project B inherited project A's workspace");
});

await test("two concurrent servers do not share a workspace", async () => {
  const [one, two] = await Promise.all([
    get(a.origin, "/api/workspace", tokenA),
    get(b.origin, "/api/workspace", tokenB),
  ]);
  assert.strictEqual(one.workspace, projectA);
  assert.strictEqual(two.workspace, projectB);
});

// ── VS Code compatibility: a bound session still wins ────────────────────────

await test("a session-bound workspace (the extension path) overrides the CLI one", async () => {
  const bound = project("kodo-extension-project");
  const res = await fetch(`${a.origin}/api/auth/workspace`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ workspacePath: bound }),
  });
  assert.strictEqual((await res.json()).ok, true);

  const body = await get(a.origin, "/api/workspace", tokenA);
  assert.strictEqual(body.workspace, bound, "the extension's binding must win over the CLI default");
  assert.strictEqual(body.source, "session");
});

for (const child of started) child.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 500));
for (const child of started) if (!child.killed) child.kill("SIGKILL");
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
