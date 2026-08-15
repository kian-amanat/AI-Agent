/**
 * src/runtime/identity.mjs — proving a process is the Kodo server we started.
 *
 * `kodo ui stop` must never signal a PID it has not positively identified, and
 * PIDs get recycled. The proof is: the server publishes a hash of its runtime
 * token on /health, and the CLI — which holds the token, read from a 0600 file
 * it wrote itself — recomputes the hash and compares.
 *
 * The hash, not the token. Publishing the token would let any process on the
 * machine read a working bearer credential for an agent that can edit files and
 * run commands, which is a strictly worse position than the 0600 file we
 * started from.
 */

import crypto from "crypto";

export function identityOf(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/** Constant-time compare, so identity checking cannot be probed by timing. */
export function identityMatches(token, published) {
  if (typeof published !== "string") return false;
  const expected = Buffer.from(identityOf(token));
  const actual = Buffer.from(published);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}
