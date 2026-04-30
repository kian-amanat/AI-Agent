import db from "../db.js";
import bcrypt from "bcrypt";

export function initUserModel() {
  db.serialize(() => {
    db.run(
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    const email = "test@example.com";
    const plainPassword = "password123";
    const saltRounds = 10;
    const passwordHash = bcrypt.hashSync(plainPassword, saltRounds);

    db.run(
      `INSERT OR IGNORE INTO users (email, password_hash, name)
       VALUES (?, ?, ?)`,
      [email, passwordHash, "Test User"]
    );
  });
}

export function findUserByEmail(email) {
  return new Promise((resolve, reject) => {
    db.get("SELECT * FROM users WHERE email = ?", [email], (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}
