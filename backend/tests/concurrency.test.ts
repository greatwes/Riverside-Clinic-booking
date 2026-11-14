import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestContext, API_KEY, seedSlots, futureSlot } from "./setup.js";
import { bookings } from "../src/db/schema.js";

describe("Level 3 — concurrency control", () => {
  let ctx: Awaited<ReturnType<typeof createTestContext>>;

  beforeEach(async () => {
    ctx = await createTestContext();
    await seedSlots(ctx.db, [futureSlot("s1")]);
  });

  it("lets exactly one of 10 simultaneous bookings for the same slot succeed", async () => {
    const attempts = Array.from({ length: 10 }, (_, i) =>
      request(ctx.app)
        .post("/bookings")
        .set("X-API-Key", API_KEY)
        .send({ slot_id: "s1", name: `Patient ${i}`, email: `patient${i}@example.com` }),
    );

    const results = await Promise.all(attempts);
    const statuses = results.map((r) => r.status).sort();

    const successes = statuses.filter((s) => s === 201);
    const conflicts = statuses.filter((s) => s === 409);

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(9);
    expect(successes.length + conflicts.length).toBe(10);

    const slotsRes = await request(ctx.app).get("/slots").set("X-API-Key", API_KEY);
    expect(slotsRes.body.slots[0].available).toBe(false);

    const rows = await ctx.db.select().from(bookings).where(eq(bookings.slotId, "s1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("confirmed");
  });
});
