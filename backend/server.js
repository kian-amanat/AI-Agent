import express from "express";
import cors from "cors";

const app = express();

app.use(express.json());
app.use(cors({ origin: "http://localhost:5173" }));

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body;

  if (email === "test@example.com" && password === "password123") {
    res.json({ message: "Login successful", token: "dummy_token_123", user: { email } });
  } else {
    res.status(401).json({ error: "Invalid credentials" });
  }
});

app.post("/api/refresh", (req, res) => {
  const { token } = req.body;

  if (token === "dummy_token_123") {
    res.json({ token: "dummy_token_456" });
  } else {
    res.status(401).json({ error: "Invalid token" });
  }
});

const PORT = process.env.PORT || 4000;

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log("Backend server listening on port", PORT);
  });
}

export default app;
