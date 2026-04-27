import express from "express";
import crypto from "crypto";

export function createApp(db) {
  const app = express();
  app.use(express.json());

  function generateToken() {
    return crypto.randomBytes(30).toString("hex");
  }

  // ---------------------------------------------
  // POST /api/login
  // ---------------------------------------------
  app.post("/api/login", async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password)
      return res.status(400).json({ error: "Username and password are required" });

    const user = await db.get(
      "SELECT * FROM users WHERE username = ? AND password = ?",
      [username, password]
    );

    if (!user)
      return res.status(401).json({ error: "Invalid username or password" });

    const accessToken = generateToken();
    const refreshToken = generateToken();

    await db.run(
      "INSERT INTO sessions (user_id, refresh_token) VALUES (?, ?)",
      [user.id, refreshToken]
    );

    return res.json({ accessToken, refreshToken });
  });

  // ---------------------------------------------
  // POST /api/refresh
  // ---------------------------------------------
  app.post("/api/refresh", async (req, res) => {
    const { refreshToken } = req.body;

    if (!refreshToken)
      return res.status(400).json({ error: "Refresh token is required" });

    const session = await db.get(
      "SELECT * FROM sessions WHERE refresh_token = ?",
      [refreshToken]
    );

    if (!session)
      return res.status(403).json({ error: "Invalid refresh token" });

    const newAccessToken = generateToken();

    return res.json({ accessToken: newAccessToken });
  });

  return app;
}
