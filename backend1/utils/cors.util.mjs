/**
 * utils/cors.util.mjs — which browser origins may call this API.
 *
 * One definition, used by server.mjs's global hook and by the per-route helpers
 * in routes/plannerAgent.mjs (SSE writes its headers on the raw socket, so it
 * cannot reuse the hook's value and needs the same rule available directly).
 * Two copies of this would drift, and the drift would be a security hole rather
 * than a cosmetic inconsistency.
 *
 * The rule: any LOOPBACK origin, and nothing else.
 *
 * The UI's port is not knowable when the API starts — `kodo ui start` chooses
 * it afterwards, and `--port 0` deliberately asks for whatever is free — so a
 * single hardcoded origin cannot work. `*` is not the answer either: this API
 * carries bearer tokens and drives an agent that edits files and runs commands,
 * so a wildcard would let any page the user has open make credentialed requests
 * to it. Allowing every loopback port covers the CLI's real needs while still
 * refusing the entire public web.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** The historical default, used when there is no Origin header to reflect. */
export const DEFAULT_ORIGIN = "http://localhost:3000";

/** Set to pin one exact origin (deployments that want a fixed front end). */
export const PINNED_ORIGIN = process.env.KODO_ALLOWED_ORIGIN || "";

export function isLoopbackOrigin(origin) {
  if (!origin) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * The value to send in Access-Control-Allow-Origin for this request.
 * Always a concrete origin, never "*", so credentialed requests stay valid
 * while non-loopback callers get an origin that will not match theirs.
 */
export function allowedOrigin(requestOrigin) {
  if (PINNED_ORIGIN) return PINNED_ORIGIN;
  return isLoopbackOrigin(requestOrigin) ? requestOrigin : DEFAULT_ORIGIN;
}
