import db from "../db.js";

export function initTokenModel() {
  db.serialize(() => {
    db.run(
      `CREATE TABLE IF NOT EXISTS refresh_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        is_revoked INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
      )`
    );
  });
}

export function createRefreshTokenRecord({ userId, token }) {
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO refresh_tokens (user_id, token, is_revoked) VALUES (?, ?, 0)",
      [userId, token],
      function (err) {
        if (err) return reject(err);
        resolve({ id: this.lastID });
      }
    );
  });
}

export function findRefreshTokenRecord(token) {
  return new Promise((resolve, reject) => {
    db.get(
      "SELECT * FROM refresh_tokens WHERE token = ?",
      [token],
      (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      }
    );
  });
}

export function revokeRefreshTokenRecord(token) {
  return new Promise((resolve, reject) => {
    db.run(
      "UPDATE refresh_tokens SET is_revoked = 1 WHERE token = ?",
      [token],
      function (err) {
        if (err) return reject(err);
        resolve(this.changes > 0);
      }
    );
  });
}

export async function rotateRefreshTokenRecord({ oldToken, newToken, userId }) {
  await revokeRefreshTokenRecord(oldToken);
  await createRefreshTokenRecord({ userId, token: newToken });
}
