import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createTestContext, API_KEY, seedSlots, futureSlot } from "./setup.js";

describe("Level 4 — idempotency", () => {
  let ctx: Awaited<ReturnType<typeof createTestContext>>;

  beforeEach(async () => {
    ctx = await createTestContext();
    await seedSlots(ctx.db, [futureSlot("s1")]);
  });

  it("returns the exact same booking on a retried identical request", async () => {
    const payload = { slot_id: "s1", name: "Ada Obi", email: "ada@example.com" };

    const first = await request(ctx.app)
      .post("/bookings")
      .set("X-API-Key", API_KEY)
      .set("Idempotency-Key", "key-1")
      .send(payload);
    expect(first.status).toBe(201);

    const second = await request(ctx.app)
      .post("/bookings")
      .set("X-API-Key", API_KEY)
      .set("Idempotency-Key", "key-1")
      .send(payload);

    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
  });

  it("never creates a second booking for a retried request", async () => {
    const payload = { slot_id: "s1", name: "Ada Obi", email: "ada@example.com" };

    await request(ctx.app)
      .post("/bookings")
      .set("X-API-Key", API_KEY)
      .set("Idempotency-Key", "key-2")
      .send(payload);
    await request(ctx.app)
      .post("/bookings")
      .set("X-API-Key", API_KEY)
      .set("Idempotency-Key", "key-2")
      .send(payload);

    const res = await request(ctx.app)
      .get("/bookings?email=ada@example.com&limit=50")
      .set("X-API-Key", API_KEY);
    expect(res.body.bookings).toHaveLength(1);
  });

  it("replays a failed outcome too (same key, same invalid body)", async () => {
    const payload = { slot_id: "nope", name: "Ada Obi", email: "ada@example.com" };

    const first = await request(ctx.app)
      .post("/bookings")
      .set("X-API-Key", API_KEY)
      .set("Idempotency-Key", "key-3")
      .send(payload);
    expect(first.status).toBe(404);

    const second = await request(ctx.app)
      .post("/bookings")
      .set("X-API-Key", API_KEY)
      .set("Idempotency-Key", "key-3")
      .send(payload);
    expect(second.status).toBe(404);
    expect(second.body).toEqual(first.body);
  });

  it("422s when the same key is reused with a different body", async () => {
    await request(ctx.app)
      .post("/bookings")
      .set("X-API-Key", API_KEY)
      .set("Idempotency-Key", "key-4")
      .send({ slot_id: "s1", name: "Ada Obi", email: "ada@example.com" });

    const res = await request(ctx.app)
      .post("/bookings")
      .set("X-API-Key", API_KEY)
      .set("Idempotency-Key", "key-4")
      .send({ slot_id: "s1", name: "Different Name", email: "ada@example.com" });

    expect(res.status).toBe(422);
    expect(res.body).toHaveProperty("error");
  });

  it("treats requests without an Idempotency-Key as independent attempts", async () => {
    await seedSlots(ctx.db, [futureSlot("s2")]);
    const first = await request(ctx.app)
      .post("/bookings")
      .set("X-API-Key", API_KEY)
      .send({ slot_id: "s1", name: "Ada Obi", email: "ada@example.com" });
    expect(first.status).toBe(201);

    const second = await request(ctx.app)
      .post("/bookings")
      .set("X-API-Key", API_KEY)
      .send({ slot_id: "s2", name: "Ada Obi", email: "ada@example.com" });
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
  });
});
