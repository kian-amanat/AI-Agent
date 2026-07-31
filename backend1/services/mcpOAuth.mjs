/**
 * services/mcpOAuth.mjs
 *
 * OAuth 2.1 credential handling for remote (http/sse) MCP servers.
 *
 * Full authorization-code + PKCE flow for MCP servers behind OAuth:
 *
 *   • discovery      — parse a 401's WWW-Authenticate / the server's
 *                      protected-resource + authorization-server metadata to
 *                      learn WHERE to authorize (RFC 9728 / RFC 8414),
 *   • registration   — register this client on first contact (RFC 7591), since
 *                      MCP providers rarely issue client IDs ahead of time,
 *   • authorization  — bind a loopback listener, open the consent page, and
 *                      capture the redirect (RFC 8252 native-app flow),
 *   • code exchange  — swap the code for tokens with PKCE (RFC 7636),
 *   • refresh        — renew an expired access token with no user present,
 *   • storage        — persist tokens/clients per (workspace, server) and
 *                      inject the Authorization header on every request.
 *
 * The ONLY step needing a human is approving consent in the browser, which is
 * inherent to the grant. Everything around it — including every subsequent
 * refresh — runs unattended. Tokens live in .kodo/credentials.json (mode
 * 0600), which is gitignored.
 */

import crypto from "crypto";
import http from "http";
import path from "path";
import { spawn } from "child_process";
import { promises as fs } from "fs";

const CREDENTIALS_FILE = "credentials.json";
// Refresh a little early — a token that expires mid-request is a failed run.
const EXPIRY_SKEW_MS = 60_000;

function credentialsPath(workspacePath) {
  return path.join(workspacePath, ".kodo", CREDENTIALS_FILE);
}

async function readStore(workspacePath) {
  try {
    return JSON.parse(await fs.readFile(credentialsPath(workspacePath), "utf-8"));
  } catch {
    return {};
  }
}

async function writeStore(workspacePath, store) {
  const file = credentialsPath(workspacePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // 0600: these are bearer tokens, not config.
  await fs.writeFile(file, JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export async function getStoredToken(workspacePath, serverName) {
  const store = await readStore(workspacePath);
  return store?.mcpOAuth?.[serverName] || null;
}

export async function storeToken(workspacePath, serverName, token) {
  const store = await readStore(workspacePath);
  store.mcpOAuth = store.mcpOAuth || {};
  store.mcpOAuth[serverName] = token;
  await writeStore(workspacePath, store);
  return token;
}

export async function clearToken(workspacePath, serverName) {
  const store = await readStore(workspacePath);
  if (store?.mcpOAuth?.[serverName]) {
    delete store.mcpOAuth[serverName];
    await writeStore(workspacePath, store);
  }
}

export function isExpired(token, now = Date.now()) {
  if (!token?.expiresAt) return false; // no expiry recorded → assume long-lived
  return now >= token.expiresAt - EXPIRY_SKEW_MS;
}

// ── PKCE ─────────────────────────────────────────────────────────────────────

export function createPkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// ── Discovery ────────────────────────────────────────────────────────────────

// RFC 9728: a 401 from a protected resource points at its metadata document.
export function parseWwwAuthenticate(header) {
  const h = String(header || "");
  if (!h) return null;
  const out = {};
  for (const m of h.matchAll(/([a-zA-Z_-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return Object.keys(out).length ? out : null;
}

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`metadata fetch failed (HTTP ${res.status}) for ${url}`);
  return res.json();
}

/**
 * Resolve the authorization + token endpoints for a protected MCP server.
 * Tries, in order: the resource metadata named by the 401, then the standard
 * well-known locations on the server's own origin.
 */
export async function discoverAuthServer(resourceUrl, wwwAuthenticate = null) {
  const parsed = parseWwwAuthenticate(wwwAuthenticate);
  const origin = new URL(resourceUrl).origin;

  const candidates = [];
  if (parsed?.resource_metadata) candidates.push(parsed.resource_metadata);
  candidates.push(`${origin}/.well-known/oauth-protected-resource`);

  for (const url of candidates) {
    try {
      const meta = await fetchJSON(url);
      const issuer = Array.isArray(meta?.authorization_servers) ? meta.authorization_servers[0] : null;
      if (issuer) {
        const asMeta = await fetchJSON(`${issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`);
        if (asMeta?.authorization_endpoint && asMeta?.token_endpoint) return asMeta;
      }
    } catch { /* try the next candidate */ }
  }

  // Some servers publish authorization-server metadata directly.
  for (const url of [
    `${origin}/.well-known/oauth-authorization-server`,
    `${origin}/.well-known/openid-configuration`,
  ]) {
    try {
      const meta = await fetchJSON(url);
      if (meta?.authorization_endpoint && meta?.token_endpoint) return meta;
    } catch { /* keep trying */ }
  }

  throw new Error(`Could not discover an OAuth authorization server for ${resourceUrl}.`);
}

// ── Authorization URL + token exchange ───────────────────────────────────────

export function buildAuthorizationUrl({ metadata, clientId, redirectUri, challenge, scope = "", state, resource = null }) {
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state || crypto.randomBytes(16).toString("hex"));
  if (scope) url.searchParams.set("scope", scope);
  // RFC 8707 — bind the token to this specific MCP server.
  if (resource) url.searchParams.set("resource", resource);
  return url.toString();
}

function toToken(payload, now = Date.now()) {
  if (!payload?.access_token) throw new Error("Token endpoint returned no access_token.");
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || null,
    tokenType: payload.token_type || "Bearer",
    scope: payload.scope || "",
    expiresAt: payload.expires_in ? now + Number(payload.expires_in) * 1000 : null,
  };
}

async function postForm(tokenEndpoint, form) {
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = null; }
  if (!res.ok) {
    const detail = payload?.error_description || payload?.error || text.slice(0, 200);
    throw new Error(`Token request failed (HTTP ${res.status}): ${detail}`);
  }
  return payload;
}

export async function exchangeCode({ metadata, clientId, clientSecret = null, code, redirectUri, verifier, resource = null }) {
  return toToken(await postForm(metadata.token_endpoint, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    ...(resource ? { resource } : {}),
  }));
}

export async function refreshToken({ metadata, clientId, clientSecret = null, refreshToken: rt, resource = null }) {
  if (!rt) throw new Error("No refresh token available — re-authorization is required.");
  const payload = await postForm(metadata.token_endpoint, {
    grant_type: "refresh_token",
    refresh_token: rt,
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    ...(resource ? { resource } : {}),
  });
  const next = toToken(payload);
  // Providers may omit refresh_token on renewal — keep the existing one.
  if (!next.refreshToken) next.refreshToken = rt;
  return next;
}

// ── Dynamic client registration (RFC 7591) ───────────────────────────────────
// Most MCP providers don't hand out client IDs ahead of time; the client
// registers itself on first contact. The resulting client_id (and secret, if
// the provider issues one) is persisted so this happens exactly once.

export async function registerClient({ metadata, redirectUri, clientName = "Kodo", scope = "" }) {
  if (!metadata?.registration_endpoint) {
    throw new Error("This provider does not support dynamic client registration; set oauth.clientId manually.");
  }
  const res = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // public client — PKCE is the protection
      ...(scope ? { scope } : {}),
    }),
  });
  const text = await res.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = null; }
  if (!res.ok || !payload?.client_id) {
    throw new Error(`Client registration failed (HTTP ${res.status}): ${payload?.error_description || text.slice(0, 200)}`);
  }
  return { clientId: payload.client_id, clientSecret: payload.client_secret || null };
}

export async function getStoredClient(workspacePath, serverName) {
  const store = await readStore(workspacePath);
  return store?.mcpClients?.[serverName] || null;
}

export async function storeClient(workspacePath, serverName, client) {
  const store = await readStore(workspacePath);
  store.mcpClients = store.mcpClients || {};
  store.mcpClients[serverName] = client;
  await writeStore(workspacePath, store);
  return client;
}

// ── Interactive authorization ────────────────────────────────────────────────

// Best-effort browser launch. If it fails (headless box, no DE), the caller
// still has the URL and the loopback listener is already waiting — the user
// can just paste it. Never throws.
export function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the full interactive authorization-code + PKCE flow.
 *
 * This is the one step that genuinely needs a human: the provider must show a
 * consent screen. Everything around it is automated — discovery, dynamic
 * registration, the loopback redirect listener, code exchange, and storage.
 * After this completes once, refresh keeps the server usable with no further
 * interaction.
 *
 * `onAuthUrl` receives the URL so a non-browser caller (an SSE-driven UI, a
 * CLI) can surface it instead of relying on the browser launch.
 */
export async function authorizeInteractively({
  workspacePath, serverName, config,
  onAuthUrl = null, timeoutMs = 300_000, launchBrowser = true, port = 0,
}) {
  const oauth = config?.oauth || {};
  const metadata = oauth.metadata || await discoverAuthServer(config.url);

  // Bind the loopback listener FIRST — the redirect URI must be known before
  // the authorization URL is built, and registered clients pin it exactly.
  const { server, boundPort } = await listen(port);
  const redirectUri = `http://127.0.0.1:${boundPort}/callback`;

  try {
    let clientId = oauth.clientId;
    let clientSecret = oauth.clientSecret || null;
    if (!clientId) {
      const stored = await getStoredClient(workspacePath, serverName);
      if (stored) {
        ({ clientId, clientSecret } = stored);
      } else {
        const registered = await registerClient({ metadata, redirectUri, scope: oauth.scope || "" });
        await storeClient(workspacePath, serverName, registered);
        ({ clientId, clientSecret } = registered);
      }
    }

    const { verifier, challenge } = createPkcePair();
    const state = crypto.randomBytes(16).toString("hex");
    const authUrl = buildAuthorizationUrl({
      metadata, clientId, redirectUri, challenge, state,
      scope: oauth.scope || "", resource: config.url,
    });

    onAuthUrl?.(authUrl);
    if (launchBrowser) openBrowser(authUrl);

    const code = await awaitCode(server, { expectedState: state, timeoutMs });
    const token = await exchangeCode({
      metadata, clientId, clientSecret, code, redirectUri, verifier, resource: config.url,
    });
    await storeToken(workspacePath, serverName, token);
    return { token, clientId, authUrl };
  } finally {
    server.close();
  }
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ server, boundPort: server.address().port }));
  });
}

// Attach the request handler to an already-listening server and resolve with
// the authorization code (or reject on denial / state mismatch / timeout).
function awaitCode(server, { expectedState, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };

    const page = (title, body) =>
      `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font-family:system-ui;padding:3rem;max-width:32rem;margin:auto">` +
      `<h2>${title}</h2><p>${body}</p></body>`;

    server.on("request", (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "content-type": "text/html" });
        res.end(page("Authorization failed", `The provider returned <code>${error}</code>. You can close this tab.`));
        done(reject, new Error(`Authorization denied: ${error}`));
        return;
      }
      // A mismatched state means this redirect isn't ours — refuse the code.
      if (!code || state !== expectedState) {
        res.writeHead(400, { "content-type": "text/html" });
        res.end(page("Authorization failed", "Missing code, or state validation failed. You can close this tab."));
        done(reject, new Error("Authorization callback failed state validation."));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page("Connected ✅", "Kodo is authorized for this MCP server. You can close this tab."));
      done(resolve, code);
    });

    const timer = setTimeout(
      () => done(reject, new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for authorization.`)),
      timeoutMs,
    );
    timer.unref?.();
  });
}

/**
 * Produce the Authorization header for a server, refreshing silently when the
 * stored token has expired. Returns null when the server needs a one-time
 * interactive authorization first (the caller surfaces the URL to the user).
 */
export async function resolveAuthHeader({ workspacePath, serverName, config }) {
  const oauth = config?.oauth;
  if (!oauth) return null;

  let token = await getStoredToken(workspacePath, serverName);
  if (!token) return null;

  if (isExpired(token)) {
    try {
      const metadata = oauth.metadata || await discoverAuthServer(config.url);
      token = await refreshToken({
        metadata,
        clientId: oauth.clientId,
        clientSecret: oauth.clientSecret || null,
        refreshToken: token.refreshToken,
        resource: config.url,
      });
      await storeToken(workspacePath, serverName, token);
    } catch (err) {
      console.warn(`[MCP OAuth] refresh failed for "${serverName}": ${err.message}`);
      return null;
    }
  }

  return `${token.tokenType || "Bearer"} ${token.accessToken}`;
}
