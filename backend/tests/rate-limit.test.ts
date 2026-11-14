import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createTestContext, API_KEY, seedSlots, futureSlot, pastSlot } from "./setup.js";

describe("Level 5 — rate limiting", () => {
  let ctx: Awaited<ReturnType<typeof createTestContext>>;

  beforeEach(async () => {
    ctx = await createTestContext();
    await seedSlots(ctx.db, [futureSlot("s1"), pastSlot("s_past")]);
  });

  it("allows 5 attempts per email per minute and blocks the 6th with 429 + Retry-After", async () => {
    const email = "spammer@example.com";

    for (let i = 0; i < 5; i++) {
      // Each of these fails validation (slot already started), but failed
      // attempts still count against the per-email budget per the spec.
      // eslint-disable-next-line no-await-in-loop
      const res = await request(ctx.app)
        .post("/bookings")
        .set("X-API-Key", API_KEY)
        .send({ slot_id: "s_past", name: "Spammer", email });
      expect(res.status).toBe(400);
    }

    const sixth = await request(ctx.app)
      .post("/bookings")
      .set("X-API-Key", API_KEY)
      .send({ slot_id: "s_past", name: "Spammer", email });

    expect(sixth.status).toBe(429);
    expect(sixth.body).toHaveProperty("error");
    expect(sixth.headers["retry-after"]).toBeDefined();
    expect(Number.isInteger(Number(sixth.headers["retry-after"]))).toBe(true);
    expect(Number(sixth.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("does not rate-limit other emails", async () => {
    const spammer = "spammer2@example.com";
    for (let i = 0; i < 6; i++) {
      // eslint-disable-next-line no-await-in-loop
      await request(ctx.app)
        .post("/bookings")
        .set("X-API-Key", API_KEY)
        .send({ slot_id: "s_past", name: "Spammer", email: spammer });
    }

    const other = await request(ctx.app)
      .post("/bookings")
      .set("X-API-Key", API_KEY)
      .send({ slot_id: "s1", name: "Ada Obi", email: "ada@example.com" });

    expect(other.status).toBe(201);
  });
});
