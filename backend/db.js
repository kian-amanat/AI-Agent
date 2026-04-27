```javascript
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

// Initialize and configure SQLite database connection
const initializeDatabase = async () => {
  const db = await open({
    filename: './database.sqlite',
    driver: sqlite3.Database,
  });

  // Create users table if it doesn't exist
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    );
  `);

  // Create sessions table if it doesn't exist
  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      refreshToken TEXT NOT NULL,
      expiresAt DATETIME NOT NULL,
      FOREIGN KEY (userId) REFERENCES users (id)
    );
  `);

  return db;
};

// Export the database initialization function
export default initializeDatabase;
```