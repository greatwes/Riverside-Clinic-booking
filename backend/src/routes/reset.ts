import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db/client.js";
import { slots, bookings, slotLocks, idempotencyKeys } from "../db/schema.js";

export const resetRouter = Router();

const SlotInput = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  start: z.coerce.date(),
  end: z.coerce.date(),
});

const ResetBody = z.object({
  slots: z.array(SlotInput),
});

resetRouter.post("/reset", async (req, res) => {
  const parsed = ResetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "body must be { slots: Slot[] }" });
    return;
  }

  const db = getDb();
  // Not wrapped in a transaction: this is an admin/test-fixture endpoint, not
  // one clients race against, and keeping it to plain statements means it
  // works the same against the pg-proxy driver used in tests (which doesn't
  // implement transactions) and a real Postgres connection in production.
  await db.delete(idempotencyKeys);
  await db.delete(slotLocks);
  await db.delete(bookings);
  await db.delete(slots);
  if (parsed.data.slots.length > 0) {
    await db.insert(slots).values(
      parsed.data.slots.map((s) => ({
        id: s.id,
        provider: s.provider,
        start: s.start,
        end: s.end,
      })),
    );
  }

  res.status(200).json({ ok: true, slots: parsed.data.slots.length });
});
