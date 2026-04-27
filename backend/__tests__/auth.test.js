import request from "supertest";
import { createApp } from "../app.js";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

let db;
let app;

beforeAll(async () => {
  db = await open({
    filename: ":memory:",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    );

    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      refresh_token TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    INSERT INTO users (username, password)
    VALUES ('testuser', 'password123');
  `);

  app = createApp(db);
});

afterAll(async () => {
  await db.close();
});

describe("Authentication API", () => {
  describe("POST /api/login", () => {
    it("should login successfully with valid credentials", async () => {
      const response = await request(app)
        .post("/api/login")
        .send({ username: "testuser", password: "password123" });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("accessToken");
      expect(response.body).toHaveProperty("refreshToken");
    });

    it("should fail to login with invalid credentials", async () => {
      const response = await request(app)
        .post("/api/login")
        .send({ username: "testuser", password: "wrongpassword" });

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty(
        "error",
        "Invalid username or password"
      );
    });
  });

  describe("POST /api/refresh", () => {
    let refreshToken;

    beforeAll(async () => {
      const loginResponse = await request(app)
        .post("/api/login")
        .send({ username: "testuser", password: "password123" });

      refreshToken = loginResponse.body.refreshToken;
    });

    it("should refresh tokens with a valid refresh token", async () => {
      const response = await request(app)
        .post("/api/refresh")
        .send({ refreshToken });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("accessToken");
    });

    it("should fail to refresh tokens with an invalid refresh token", async () => {
      const response = await request(app)
        .post("/api/refresh")
        .send({ refreshToken: "invalidtoken" });

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty("error", "Invalid refresh token");
    });
  });
});
