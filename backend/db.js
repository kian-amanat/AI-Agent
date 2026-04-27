```javascript
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

let db;

export async function initDB() {
  db = await open({
    filename: './database.sqlite',
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      refreshToken TEXT NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}

export async function getUserByUsername(username) {
  return db.get('SELECT * FROM users WHERE username = ?', username);
}

export async function createUser(username, password) {
  return db.run('INSERT INTO users (username, password) VALUES (?, ?)', username, password);
}

export async function createSession(userId, refreshToken) {
  return db.run('INSERT INTO sessions (userId, refreshToken) VALUES (?, ?)', userId, refreshToken);
}

export async function getSessionByRefreshToken(refreshToken) {
  return db.get('SELECT * FROM sessions WHERE refreshToken = ?', refreshToken);
}

export async function deleteSessionByRefreshToken(refreshToken) {
  return db.run('DELETE FROM sessions WHERE refreshToken = ?', refreshToken);
}

export async function closeDB() {
  if (db) {
    await db.close();
  }
}
```