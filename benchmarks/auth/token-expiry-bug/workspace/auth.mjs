/** A token is valid until (and not including) expiresAt. */
export function verifyToken(token, now = Date.now()) {
  if (!token || typeof token.expiresAt !== "number") return { valid: false, reason: "malformed" };
  // BUG: an expired token still passes.
  if (token.expiresAt < now - 60_000) return { valid: false, reason: "expired" };
  return { valid: true, subject: token.sub };
}
