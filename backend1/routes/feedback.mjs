import db from "../db.mjs";

/**
 * POST /api/feedback
 * Body: { rating: number, comment: string }
 * Stores feedback in SQLite and returns { ok: true, id: number }
 */
export default async function feedbackRoute(fastify, opts) {
  // Create the feedbacks table if it doesn't exist
  fastify.addHook("onReady", async () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS feedbacks (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        rating     INTEGER NOT NULL,
        comment    TEXT,
        created_at TEXT    NOT NULL DEFAULT (datetime('now'))
      );
    `);
  });

  fastify.post("/", async (request, reply) => {
    try {
      const { rating, comment } = request.body ?? {};

      // Validate rating
      if (!rating || typeof rating !== "number" || rating < 1 || rating > 5) {
        return reply.code(400).send({
          ok: false,
          error: "Rating must be a number between 1 and 5",
        });
      }

      // Sanitize comment
      const sanitizedComment =
        typeof comment === "string"
          ? comment.slice(0, 2000)
          : null;

      const stmt = db.prepare(`
        INSERT INTO feedbacks (rating, comment, created_at)
        VALUES (?, ?, ?)
      `);
      const result = stmt.run(rating, sanitizedComment, new Date().toISOString());

      return reply.code(201).send({
        ok: true,
        id: result.lastInsertRowid,
        message: "Thank you for your feedback!",
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({
        ok: false,
        error: "Failed to save feedback",
      });
    }
  });

  // GET /api/feedback — list all feedback (admin-only, no auth for now)
  fastify.get("/", async (request, reply) => {
    try {
      const rows = db.prepare(`
        SELECT id, rating, comment, created_at
        FROM feedbacks
        ORDER BY created_at DESC
        LIMIT 100
      `).all();

      return {
        ok: true,
        feedbacks: rows,
        total: rows.length,
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({
        ok: false,
        error: "Failed to fetch feedback",
      });
    }
  });
}
