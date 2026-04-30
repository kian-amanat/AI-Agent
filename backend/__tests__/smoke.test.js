import request from "supertest";
import app from "../server.js";

describe("smoke", () => {
  it("healthcheck works", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "ok");
  });
});
