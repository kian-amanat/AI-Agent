```javascript
import request from 'supertest';
import app from '../server.js';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

let db;

beforeAll(async () => {
  db = await open({
    filename: ':memory:',
    driver: sqlite3.Database,
  });

  await db.exec(`
//     CREATE TABLE users (  // auto-commented by backend_agent (SQL should live in db.js)
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    );

//     CREATE TABLE sessions (  // auto-commented by backend_agent (SQL should live in db.js)
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      refresh_token TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users (id)
    );

    INSERT INTO users (username, password) VALUES ('testuser', 'password123');
  `);
});

afterAll(async () => {
  await db.close();
});

describe('Authentication API', () => {
  describe('POST /api/login', () => {
    it('should return 200 and tokens for valid credentials', async () => {
      const response = await request(app)
        .post('/api/login')
        .send({ username: 'testuser', password: 'password123' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('accessToken');
      expect(response.body).toHaveProperty('refreshToken');
    });

    it('should return 401 for invalid credentials', async () => {
      const response = await request(app)
        .post('/api/login')
        .send({ username: 'testuser', password: 'wrongpassword' });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Invalid username or password' });
    });

    it('should return 400 if username or password is missing', async () => {
      const response = await request(app)
        .post('/api/login')
        .send({ username: 'testuser' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Username and password are required' });
    });
  });

  describe('POST /api/refresh', () => {
    let refreshToken;

    beforeAll(async () => {
      const response = await request(app)
        .post('/api/login')
        .send({ username: 'testuser', password: 'password123' });

      refreshToken = response.body.refreshToken;
    });

    it('should return 200 and a new access token for a valid refresh token', async () => {
      const response = await request(app)
        .post('/api/refresh')
        .send({ refreshToken });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('accessToken');
    });

    it('should return 401 for an invalid refresh token', async () => {
      const response = await request(app)
        .post('/api/refresh')
        .send({ refreshToken: 'invalidtoken' });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Invalid refresh token' });
    });

    it('should return 400 if refresh token is missing', async () => {
      const response = await request(app)
        .post('/api/refresh')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Refresh token is required' });
    });
  });
});
```