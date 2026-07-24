import db from "../db.mjs";

const OWNER_EMAIL = "kian.amanat.9@gmail.com";
const ADMIN_PASSWORD = "19kian95";

/**
 * POST /api/feedback
 * Body: { rating: number, comment: string, email?: string }
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
        email      TEXT,
        created_at TEXT    NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Migrate older databases: the `email` column was added after this table
    // may have first been created, and CREATE TABLE IF NOT EXISTS won't add it
    // to a pre-existing table. Add it if it's missing so every query that
    // references `email` (admin list, insert) keeps working.
    const columns = db.prepare(`PRAGMA table_info(feedbacks)`).all();
    if (!columns.some((c) => c.name === "email")) {
      db.exec(`ALTER TABLE feedbacks ADD COLUMN email TEXT`);
    }
  });

  fastify.post("/", async (request, reply) => {
    try {
      const { rating, comment, email } = request.body ?? {};

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

      // Sanitize email
      const sanitizedEmail =
        typeof email === "string"
          ? email.slice(0, 255).toLowerCase().trim()
          : null;

      const stmt = db.prepare(`
        INSERT INTO feedbacks (rating, comment, email, created_at)
        VALUES (?, ?, ?, ?)
      `);
      const result = stmt.run(rating, sanitizedComment, sanitizedEmail, new Date().toISOString());

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

  // POST /api/feedback/admin/login — verify admin credentials
  fastify.post("/admin/login", async (request, reply) => {
    try {
      const { email, password } = request.body ?? {};

      if (email !== OWNER_EMAIL || password !== ADMIN_PASSWORD) {
        return reply.code(401).send({
          ok: false,
          error: "Invalid admin credentials. Access denied.",
        });
      }

      return { ok: true, email: OWNER_EMAIL };
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({
        ok: false,
        error: "Failed to authenticate",
      });
    }
  });

  // GET /api/feedback/admin — admin-only, requires owner email in query
  fastify.get("/admin", async (request, reply) => {
    try {
      const { email: submittedEmail } = request.query;

      // Verify the requester is the owner (email match)
      if (submittedEmail !== OWNER_EMAIL) {
        return reply.code(403).send({
          ok: false,
          error: "Forbidden: only the owner can access this data",
        });
      }

      const rows = db.prepare(`
        SELECT id, rating, comment, email, created_at
        FROM feedbacks
        ORDER BY created_at DESC
        LIMIT 200
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

  // DELETE /api/feedback/:id — admin-only, requires owner email in query
  fastify.delete("/:id", async (request, reply) => {
    try {
      const { id } = request.params;
      const { email: submittedEmail } = request.query;

      // Verify the requester is the owner
      if (submittedEmail !== OWNER_EMAIL) {
        return reply.code(403).send({
          ok: false,
          error: "Forbidden: only the owner can access this data",
        });
      }

      const stmt = db.prepare(`DELETE FROM feedbacks WHERE id = ?`);
      stmt.run(id);

      return { ok: true, message: "Feedback deleted" };
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({
        ok: false,
        error: "Failed to delete feedback",
      });
    }
  });
}
