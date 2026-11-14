import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createTestContext, API_KEY } from "./setup.js";

describe("API key auth", () => {
  let app: Awaited<ReturnType<typeof createTestContext>>["app"];

  beforeEach(async () => {
    ({ app } = await createTestContext());
  });

  it("rejects requests with no API key", async () => {
    const res = await request(app).get("/slots");
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error");
  });

  it("rejects requests with a wrong API key", async () => {
    const res = await request(app).get("/slots").set("X-API-Key", "wrong-key");
    expect(res.status).toBe(401);
  });

  it("accepts requests with the correct API key", async () => {
    const res = await request(app).get("/slots").set("X-API-Key", API_KEY);
    expect(res.status).toBe(200);
  });

  it("does not require an API key for /health", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });
});
