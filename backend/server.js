import express from "express";
import cors from "cors";

const app = express();

app.use(express.json());
app.use(cors({ origin: "http://localhost:5173" }));

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// TODO: Implement /api/login and /api/refresh endpoints using SQLite.

const PORT = process.env.PORT || 4000;

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log("Backend server listening on port", PORT);
  });
}

export default app;
