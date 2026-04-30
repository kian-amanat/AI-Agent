import { verifyAccessToken } from "../utils/jwt.js";

export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing access token" });
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.userId };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
