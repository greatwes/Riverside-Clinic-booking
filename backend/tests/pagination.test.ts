import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createTestContext, API_KEY, seedSlots, futureSlot } from "./setup.js";

describe("Level 4 — pagination of a person's bookings", () => {
  let ctx: Awaited<ReturnType<typeof createTestContext>>;
  const email = "ada@example.com";

  beforeEach(async () => {
    ctx = await createTestContext();
    const slotRows = Array.from({ length: 5 }, (_, i) => futureSlot(`s${i}`, "Dr Ade", 24 + i));
    await seedSlots(ctx.db, slotRows);

    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      await request(ctx.app)
        .post("/bookings")
        .set("X-API-Key", API_KEY)
        .send({ slot_id: `s${i}`, name: "Ada Obi", email });
    }
  });

  it("paginates with limit, returning a next_cursor until exhausted", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 10; page++) {
      const url = cursor
        ? `/bookings?email=${email}&limit=2&cursor=${encodeURIComponent(cursor)}`
        : `/bookings?email=${email}&limit=2`;
      const res = await request(ctx.app).get(url).set("X-API-Key", API_KEY);
      expect(res.status).toBe(200);
      seen.push(...res.body.bookings.map((b: { id: string }) => b.id));
      cursor = res.body.next_cursor;
      if (!cursor) break;
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("returns bookings oldest first", async () => {
    const res = await request(ctx.app)
      .get(`/bookings?email=${email}&limit=50`)
      .set("X-API-Key", API_KEY);
    const createdAts = res.body.bookings.map((b: { created_at: string }) => b.created_at);
    const sorted = [...createdAts].sort();
    expect(createdAts).toEqual(sorted);
  });

  it("matches email case-insensitively", async () => {
    const res = await request(ctx.app)
      .get(`/bookings?email=${encodeURIComponent("ADA@EXAMPLE.COM")}&limit=50`)
      .set("X-API-Key", API_KEY);
    expect(res.body.bookings).toHaveLength(5);
  });

  it("400s on an out-of-range limit", async () => {
    const res = await request(ctx.app)
      .get(`/bookings?email=${email}&limit=0`)
      .set("X-API-Key", API_KEY);
    expect(res.status).toBe(400);

    const res2 = await request(ctx.app)
      .get(`/bookings?email=${email}&limit=51`)
      .set("X-API-Key", API_KEY);
    expect(res2.status).toBe(400);
  });

  it("defaults the limit to 10", async () => {
    const res = await request(ctx.app).get(`/bookings?email=${email}`).set("X-API-Key", API_KEY);
    expect(res.body.bookings.length).toBeLessThanOrEqual(10);
  });
});
