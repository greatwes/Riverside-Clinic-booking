import { Router } from "express";
import { asc, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { slots, slotLocks } from "../db/schema.js";

export const slotsRouter = Router();

slotsRouter.get("/slots", async (req, res) => {
  const db = getDb();
  const provider = typeof req.query.provider === "string" ? req.query.provider : undefined;

  const rows = await db
    .select({
      id: slots.id,
      provider: slots.provider,
      start: slots.start,
      end: slots.end,
      lockedSlotId: slotLocks.slotId,
    })
    .from(slots)
    .leftJoin(slotLocks, eq(slotLocks.slotId, slots.id))
    .where(provider !== undefined ? eq(slots.provider, provider) : undefined)
    .orderBy(asc(slots.start));

  res.status(200).json({
    slots: rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      start: row.start.toISOString(),
      end: row.end.toISOString(),
      available: row.lockedSlotId === null,
    })),
  });
});
