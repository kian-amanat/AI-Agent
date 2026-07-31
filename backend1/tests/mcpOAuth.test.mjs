/**
 * tests/mcpOAuth.test.mjs
 * Run with: node tests/mcpOAuth.test.mjs
 *
 * OAuth for remote MCP servers, tested against a REAL http.Server standing in
 * for the provider: metadata discovery, dynamic client registration, the full
 * interactive authorization-code + PKCE flow through a real loopback redirect,
 * silent refresh, and token persistence.
 *
 * The only thing simulated is the human clicking "approve" — the fixture's
 * /authorize redirects straight back, which is exactly what a provider does
 * once consent is given. The loopback listener, state validation and code
 * exchange are all the real implementation.
 */

import assert from "assert";
import crypto from "crypto";
import http from "http";
import path from "path";
import fs from "fs/promises";
import os from "os";

import {
  createPkcePair, parseWwwAuthenticate, discoverAuthServer,
  buildAuthorizationUrl, exchangeCode, refreshToken,
  storeToken, getStoredToken, clearToken, isExpired, resolveAuthHeader,
  registerClient, getStoredClient, authorizeInteractively,
} from "../services/mcpOAuth.mjs";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = ""; req.on("data", (d) => { b += d; }); req.on("end", () => resolve(b));
  });
}

// A provider exposing RFC 9728 resource metadata + RFC 8414 AS metadata,
// a PKCE-validating token endpoint, and refresh.
function startProvider() {
  const seen = { tokenRequests: [], registrations: [], authorizeParams: [] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const origin = `http://${req.headers.host}`;

    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        code_challenge_methods_supported: ["S256"],
      });
    }
    // RFC 7591 dynamic client registration.
    if (url.pathname === "/register") {
      const body = JSON.parse(await readBody(req));
      seen.registrations.push(body);
      return json(201, { client_id: "dyn-client-1", redirect_uris: body.redirect_uris });
    }
    // Stands in for the consent screen: immediately redirects back with a code,
    // which is exactly what the provider does once a human approves.
    if (url.pathname === "/authorize") {
      const redirect = new URL(url.searchParams.get("redirect_uri"));
      seen.authorizeParams.push(Object.fromEntries(url.searchParams));
      redirect.searchParams.set("code", "auth-code-1");
      redirect.searchParams.set("state", url.searchParams.get("state"));
      res.writeHead(302, { location: redirect.toString() });
      return res.end();
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(await readBody(req));
      seen.tokenRequests.push(Object.fromEntries(form));
      if (form.get("grant_type") === "authorization_code") {
        if (!form.get("code_verifier")) return json(400, { error: "invalid_request", error_description: "PKCE verifier required" });
        return json(200, { access_token: "access-1", refresh_token: "refresh-1", token_type: "Bearer", expires_in: 3600 });
      }
      if (form.get("grant_type") === "refresh_token") {
        if (form.get("refresh_token") !== "refresh-1") return json(400, { error: "invalid_grant" });
        return json(200, { access_token: "access-2", token_type: "Bearer", expires_in: 3600 });
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    // The protected MCP endpoint itself: 401 + a pointer to its metadata.
    res.writeHead(401, {
      "content-type": "application/json",
      "www-authenticate": `Bearer realm="mcp", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    });
    res.end(JSON.stringify({ error: "unauthorized" }));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}`, seen }));
  });
}

const close = (s) => new Promise((r) => s.close(r));
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-oauth-"));

console.log("\n📦 PKCE + WWW-Authenticate parsing");

await test("PKCE pair is a valid S256 challenge/verifier", () => {
  const { verifier, challenge } = createPkcePair();
  assert.ok(verifier.length >= 43, "verifier must meet RFC 7636 minimum entropy");
  assert.ok(!/[+/=]/.test(challenge), "challenge must be base64url, not base64");
  assert.notStrictEqual(verifier, challenge);
});

await test("WWW-Authenticate params are parsed", () => {
  const out = parseWwwAuthenticate('Bearer realm="mcp", resource_metadata="https://x/.well-known/oauth-protected-resource"');
  assert.strictEqual(out.realm, "mcp");
  assert.strictEqual(out.resource_metadata, "https://x/.well-known/oauth-protected-resource");
  assert.strictEqual(parseWwwAuthenticate(""), null);
});

console.log("\n📦 discovery + authorization URL (real provider)");

await test("the authorization server is discovered from a 401's metadata pointer", async () => {
  const { server, origin } = await startProvider();
  try {
    const res = await fetch(`${origin}/mcp`, { method: "POST" });
    assert.strictEqual(res.status, 401);
    const meta = await discoverAuthServer(`${origin}/mcp`, res.headers.get("www-authenticate"));
    assert.strictEqual(meta.token_endpoint, `${origin}/token`);
    assert.strictEqual(meta.authorization_endpoint, `${origin}/authorize`);
  } finally { await close(server); }
});

await test("discovery also works with no WWW-Authenticate header (well-known fallback)", async () => {
  const { server, origin } = await startProvider();
  try {
    const meta = await discoverAuthServer(`${origin}/mcp`, null);
    assert.strictEqual(meta.token_endpoint, `${origin}/token`);
  } finally { await close(server); }
});

await test("an authorization URL carries PKCE, redirect and resource binding", () => {
  const { challenge } = createPkcePair();
  const url = new URL(buildAuthorizationUrl({
    metadata: { authorization_endpoint: "https://p/authorize" },
    clientId: "cid", redirectUri: "http://127.0.0.1:7777/callback",
    challenge, scope: "mcp:read", state: "st8", resource: "https://x/mcp",
  }));
  assert.strictEqual(url.searchParams.get("response_type"), "code");
  assert.strictEqual(url.searchParams.get("code_challenge_method"), "S256");
  assert.strictEqual(url.searchParams.get("code_challenge"), challenge);
  assert.strictEqual(url.searchParams.get("resource"), "https://x/mcp", "RFC 8707 audience binding");
  assert.strictEqual(url.searchParams.get("state"), "st8");
});

console.log("\n📦 code exchange + refresh (real provider)");

await test("an authorization code is exchanged for tokens", async () => {
  const { server, origin, seen } = await startProvider();
  try {
    const metadata = await discoverAuthServer(`${origin}/mcp`);
    const { verifier } = createPkcePair();
    const token = await exchangeCode({
      metadata, clientId: "cid", code: "the-code",
      redirectUri: "http://127.0.0.1:7777/callback", verifier, resource: `${origin}/mcp`,
    });
    assert.strictEqual(token.accessToken, "access-1");
    assert.strictEqual(token.refreshToken, "refresh-1");
    assert.ok(token.expiresAt > Date.now(), "expiry must be absolute, not relative");
    assert.strictEqual(seen.tokenRequests.at(-1).code_verifier, verifier, "PKCE verifier must be sent");
  } finally { await close(server); }
});

await test("a request without the PKCE verifier is rejected by the provider", async () => {
  const { server, origin } = await startProvider();
  try {
    const metadata = await discoverAuthServer(`${origin}/mcp`);
    await assert.rejects(
      () => exchangeCode({ metadata, clientId: "cid", code: "c", redirectUri: "http://x/cb", verifier: "" }),
      /PKCE verifier required/,
    );
  } finally { await close(server); }
});

await test("an expired token is refreshed with no user present", async () => {
  const { server, origin } = await startProvider();
  try {
    const metadata = await discoverAuthServer(`${origin}/mcp`);
    const next = await refreshToken({ metadata, clientId: "cid", refreshToken: "refresh-1" });
    assert.strictEqual(next.accessToken, "access-2");
    assert.strictEqual(next.refreshToken, "refresh-1", "provider omitted it; the old one must be retained");
  } finally { await close(server); }
});

await test("a rejected refresh surfaces a clear error", async () => {
  const { server, origin } = await startProvider();
  try {
    const metadata = await discoverAuthServer(`${origin}/mcp`);
    await assert.rejects(() => refreshToken({ metadata, clientId: "cid", refreshToken: "wrong" }), /invalid_grant/);
  } finally { await close(server); }
});

console.log("\n📦 storage + header injection");

await test("tokens round-trip through .kodo/credentials.json at mode 0600", async () => {
  await storeToken(workspace, "remote", { accessToken: "a", refreshToken: "r", tokenType: "Bearer", expiresAt: Date.now() + 60_000 });
  const got = await getStoredToken(workspace, "remote");
  assert.strictEqual(got.accessToken, "a");
  const stat = await fs.stat(path.join(workspace, ".kodo", "credentials.json"));
  assert.strictEqual(stat.mode & 0o777, 0o600, "bearer tokens must not be world-readable");
  await clearToken(workspace, "remote");
  assert.strictEqual(await getStoredToken(workspace, "remote"), null);
});

await test("isExpired honours the early-refresh skew", () => {
  assert.strictEqual(isExpired({ expiresAt: Date.now() + 3600_000 }), false);
  assert.strictEqual(isExpired({ expiresAt: Date.now() + 5_000 }), true, "about to expire counts as expired");
  assert.strictEqual(isExpired({ expiresAt: null }), false, "no recorded expiry → assume long-lived");
});

await test("a valid stored token becomes an Authorization header", async () => {
  await storeToken(workspace, "remote", { accessToken: "tok", tokenType: "Bearer", expiresAt: Date.now() + 3600_000 });
  const header = await resolveAuthHeader({ workspacePath: workspace, serverName: "remote", config: { url: "https://x/mcp", oauth: { clientId: "cid" } } });
  assert.strictEqual(header, "Bearer tok");
  await clearToken(workspace, "remote");
});

await test("an EXPIRED stored token is refreshed transparently and re-persisted", async () => {
  const { server, origin } = await startProvider();
  try {
    await storeToken(workspace, "remote", { accessToken: "old", refreshToken: "refresh-1", tokenType: "Bearer", expiresAt: Date.now() - 1000 });
    const header = await resolveAuthHeader({
      workspacePath: workspace, serverName: "remote",
      config: { url: `${origin}/mcp`, oauth: { clientId: "cid" } },
    });
    assert.strictEqual(header, "Bearer access-2", "should have silently refreshed");
    assert.strictEqual((await getStoredToken(workspace, "remote")).accessToken, "access-2", "refreshed token must be persisted");
  } finally {
    await clearToken(workspace, "remote");
    await close(server);
  }
});

await test("a server with no oauth config and no token yields no header", async () => {
  assert.strictEqual(await resolveAuthHeader({ workspacePath: workspace, serverName: "none", config: { url: "https://x" } }), null);
  assert.strictEqual(await resolveAuthHeader({ workspacePath: workspace, serverName: "none", config: { url: "https://x", oauth: { clientId: "c" } } }), null,
    "oauth configured but not yet authorized → caller must run the interactive flow");
});

console.log("\n📦 dynamic client registration (RFC 7591)");

await test("the client registers itself and receives a client_id", async () => {
  const { server, origin, seen } = await startProvider();
  try {
    const metadata = await discoverAuthServer(`${origin}/mcp`);
    const client = await registerClient({ metadata, redirectUri: "http://127.0.0.1:7777/callback", clientName: "Kodo" });
    assert.strictEqual(client.clientId, "dyn-client-1");
    const sent = seen.registrations.at(-1);
    assert.deepStrictEqual(sent.redirect_uris, ["http://127.0.0.1:7777/callback"]);
    assert.strictEqual(sent.token_endpoint_auth_method, "none", "public client — PKCE is the protection");
    assert.ok(sent.grant_types.includes("refresh_token"), "must request refresh capability");
  } finally { await close(server); }
});

await test("a provider without a registration endpoint says so clearly", async () => {
  await assert.rejects(
    () => registerClient({ metadata: { token_endpoint: "https://x/token" }, redirectUri: "http://127.0.0.1/cb" }),
    /does not support dynamic client registration/,
  );
});

console.log("\n📦 interactive authorization (real provider + real loopback redirect)");

await test("the full flow: register → consent redirect → code → token, stored", async () => {
  const { server, origin, seen } = await startProvider();
  let surfacedUrl = null;
  try {
    const result = await authorizeInteractively({
      workspacePath: workspace,
      serverName: "interactive",
      config: { url: `${origin}/mcp`, oauth: { scope: "mcp:read" } },
      launchBrowser: false, // don't open a real browser in CI
      timeoutMs: 15_000,
      // Stand in for the human: follow the consent URL, which redirects to
      // our loopback listener exactly as a browser would.
      onAuthUrl: (url) => { surfacedUrl = url; void fetch(url, { redirect: "follow" }).catch(() => {}); },
    });

    assert.ok(surfacedUrl, "the authorization URL must be surfaced to the caller");
    assert.strictEqual(result.clientId, "dyn-client-1", "should have registered dynamically");
    assert.strictEqual(result.token.accessToken, "access-1");

    const stored = await getStoredToken(workspace, "interactive");
    assert.strictEqual(stored.accessToken, "access-1", "token must be persisted for later runs");
    assert.strictEqual((await getStoredClient(workspace, "interactive")).clientId, "dyn-client-1");

    const authParams = seen.authorizeParams.at(-1);
    assert.strictEqual(authParams.code_challenge_method, "S256");
    assert.ok(/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(authParams.redirect_uri), `loopback redirect expected, got ${authParams.redirect_uri}`);
    assert.strictEqual(authParams.resource, `${origin}/mcp`, "RFC 8707 audience binding");

    // The verifier actually sent must match the challenge that was authorized.
    const verifier = seen.tokenRequests.at(-1).code_verifier;
    const expected = crypto.createHash("sha256").update(verifier).digest("base64url");
    assert.strictEqual(expected, authParams.code_challenge, "PKCE challenge/verifier must correspond");
  } finally {
    await clearToken(workspace, "interactive");
    await close(server);
  }
});

await test("after authorizing once, later runs get a header with NO interaction", async () => {
  const { server, origin } = await startProvider();
  try {
    await authorizeInteractively({
      workspacePath: workspace, serverName: "again",
      config: { url: `${origin}/mcp`, oauth: {} },
      launchBrowser: false, timeoutMs: 15_000,
      onAuthUrl: (url) => { void fetch(url, { redirect: "follow" }).catch(() => {}); },
    });
    const header = await resolveAuthHeader({
      workspacePath: workspace, serverName: "again",
      config: { url: `${origin}/mcp`, oauth: { clientId: "dyn-client-1" } },
    });
    assert.strictEqual(header, "Bearer access-1");
  } finally {
    await clearToken(workspace, "again");
    await close(server);
  }
});

await test("a mismatched state is refused (CSRF protection)", async () => {
  const { server, origin } = await startProvider();
  try {
    await assert.rejects(
      () => authorizeInteractively({
        workspacePath: workspace, serverName: "csrf",
        config: { url: `${origin}/mcp`, oauth: {} },
        launchBrowser: false, timeoutMs: 8_000,
        // Attacker-supplied redirect: valid-looking code, wrong state.
        onAuthUrl: (url) => {
          const redirect = new URL(new URL(url).searchParams.get("redirect_uri"));
          redirect.searchParams.set("code", "injected");
          redirect.searchParams.set("state", "not-the-right-state");
          void fetch(redirect.toString()).catch(() => {});
        },
      }),
      /state validation/,
    );
  } finally { await close(server); }
});

await test("a provider denial surfaces as an error, not a hang", async () => {
  const { server, origin } = await startProvider();
  try {
    await assert.rejects(
      () => authorizeInteractively({
        workspacePath: workspace, serverName: "denied",
        config: { url: `${origin}/mcp`, oauth: {} },
        launchBrowser: false, timeoutMs: 8_000,
        onAuthUrl: (url) => {
          const redirect = new URL(new URL(url).searchParams.get("redirect_uri"));
          redirect.searchParams.set("error", "access_denied");
          void fetch(redirect.toString()).catch(() => {});
        },
      }),
      /access_denied/,
    );
  } finally { await close(server); }
});

await fs.rm(workspace, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
