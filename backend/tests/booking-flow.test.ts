import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createTestContext, API_KEY, seedSlots, futureSlot, pastSlot } from "./setup.js";

describe("Level 1 — core booking flow", () => {
  let ctx: Awaited<ReturnType<typeof createTestContext>>;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  it("lists available slots, earliest first", async () => {
    const slotA = futureSlot("s_a", "Dr Ade", 48);
    const slotB = futureSlot("s_b", "Dr Ade", 24);
    await seedSlots(ctx.db, [slotA, slotB]);

    const res = await request(ctx.app).get("/slots").set("X-API-Key", API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.slots.map((s: { id: string }) => s.id)).toEqual(["s_b", "s_a"]);
    expect(res.body.slots[0].available).toBe(true);
  });

  it("filters slots by provider", async () => {
    await seedSlots(ctx.db, [futureSlot("s_a", "Dr Ade"), futureSlot("s_b", "Dr Musa")]);
    const res = await request(ctx.app).get("/slots?provider=Dr Musa").set("X-API-Key", API_KEY);
    expect(res.body.slots).toHaveLength(1);
    expect(res.body.slots[0].id).toBe("s_b");
  });

  it("books an available slot and returns a confirmed booking", async () => {
    await seedSlots(ctx.db, [futureSlot()]);

    const res = await request(ctx.app)
      .post("/bookings")
      .set("X-API-Key", API_KEY)
      .send({ slot_id: "s1", name: "Ada Obi", email: "ada@example.com" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      slot_id: "s1",
      name: "Ada Obi",
      email: "ada@example.com",
      status: "confirmed",
    });
    expect(typeof res.body.id).toBe("string");
    expect(typeof res.body.created_at).toBe("string");
  });

  it("marks a booked slot unavailable", async () => {
    await seedSlots(ctx.db, [futureSlot()]);
    await request(ctx.app)
      .post("/bookings")
      .set("X-API-Key", API_KEY)
      .send({ slot_id: "s1", name: "Ada Obi", email: "ada@example.com" });

    const res = await request(ctx.app).get("/slots").set("X-API-Key", API_KEY);
    expect(res.body.slots[0].available).toBe(false);
  });

  it("looks up an existing booking by id", async () => {
    await seedSlots(ctx.db, [futureSlot()]);
    const created = await request(ctx.app)
      .post("/bookings")
      .set("X-API-Key", API_KEY)
      .send({ slot_id: "s1", name: "Ada Obi", email: "ada@example.com" });

    const res = await request(ctx.app)
      .get(`/bookings/${created.body.id}`)
      .set("X-API-Key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
  });

  it("404s on a booking id that doesn't exist", async () => {
    const res = await request(ctx.app).get("/bookings/does-not-exist").set("X-API-Key", API_KEY);
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });
});

describe("Level 2 — validation", () => {
  let ctx: Awaited<ReturnType<typeof createTestContext>>;

  beforeEach(async () => {
    ctx = await createTestContext();
    await seedSlots(ctx.db, [futureSlot(), pastSlot()]);
  });

  it.each([
    [{ name: "Ada Obi", email: "ada@example.com" }, "missing slot_id"],
    [{ slot_id: "s1", email: "ada@example.com" }, "missing name"],
    [{ slot_id: "s1", name: "Ada Obi" }, "missing email"],
    [{ slot_id: "s1", name: "  ", email: "ada@example.com" }, "blank name"],
    [{ slot_id: "s1", name: "Ada Obi", email: "not-an-email" }, "invalid email"],
  ])("400s for %o (%s)", async (payload) => {
    const res = await request(ctx.app).post("/bookings").set("X-API-Key", API_KEY).send(payload);
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("404s when the slot doesn't exist", async () => {
    const res = await request(ctx.app)
      .post("/bookings")
      .set("X-API-Key", API_KEY)
      .send({ slot_id: "nope", name: "Ada Obi", email: "ada@example.com" });
    expect(res.status).toBe(404);
  });

  it("400s when the slot has already started", async () => {
    const res = await request(ctx.app)
      .post("/bookings")
      .set("X-API-Key", API_KEY)
      .send({ slot_id: "s_past", name: "Ada Obi", email: "ada@example.com" });
    expect(res.status).toBe(400);
  });

  it("trims name/email and lowercases email", async () => {
    const res = await request(ctx.app)
      .post("/bookings")
      .set("X-API-Key", API_KEY)
      .send({ slot_id: "s1", name: "  Ada Obi  ", email: "  ADA@EXAMPLE.COM  " });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Ada Obi");
    expect(res.body.email).toBe("ada@example.com");
  });
});

describe("Level 3 — cancellation", () => {
  let ctx: Awaited<ReturnType<typeof createTestContext>>;

  beforeEach(async () => {
    ctx = await createTestContext();
    await seedSlots(ctx.db, [futureSlot()]);
  });

  it("cancels a booking and frees the slot for rebooking", async () => {
    const created = await request(ctx.app)
      .post("/bookings")
      .set("X-API-Key", API_KEY)
      .send({ slot_id: "s1", name: "Ada Obi", email: "ada@example.com" });

    const cancelRes = await request(ctx.app)
      .delete(`/bookings/${created.body.id}`)
      .set("X-API-Key", API_KEY);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe("cancelled");

    const slotsRes = await request(ctx.app).get("/slots").set("X-API-Key", API_KEY);
    expect(slotsRes.body.slots[0].available).toBe(true);

    const rebook = await request(ctx.app)
      .post("/bookings")
      .set("X-API-Key", API_KEY)
      .send({ slot_id: "s1", name: "Bo Smith", email: "bo@example.com" });
    expect(rebook.status).toBe(201);
  });

  it("404s cancelling a booking that doesn't exist", async () => {
    const res = await request(ctx.app).delete("/bookings/nope").set("X-API-Key", API_KEY);
    expect(res.status).toBe(404);
  });

  it("409s cancelling an already-cancelled booking", async () => {
    const created = await request(ctx.app)
      .post("/bookings")
      .set("X-API-Key", API_KEY)
      .send({ slot_id: "s1", name: "Ada Obi", email: "ada@example.com" });
    await request(ctx.app).delete(`/bookings/${created.body.id}`).set("X-API-Key", API_KEY);

    const res = await request(ctx.app)
      .delete(`/bookings/${created.body.id}`)
      .set("X-API-Key", API_KEY);
    expect(res.status).toBe(409);
  });

  it("409s booking a slot that is already confirmed-booked", async () => {
    await request(ctx.app)
      .post("/bookings")
      .set("X-API-Key", API_KEY)
      .send({ slot_id: "s1", name: "Ada Obi", email: "ada@example.com" });

    const res = await request(ctx.app)
      .post("/bookings")
      .set("X-API-Key", API_KEY)
      .send({ slot_id: "s1", name: "Bo Smith", email: "bo@example.com" });
    expect(res.status).toBe(409);
  });
});
