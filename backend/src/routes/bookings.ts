import { Router } from "express";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { getDb, type Database } from "../db/client.js";
import { bookings, slots, slotLocks, idempotencyKeys } from "../db/schema.js";
import { checkRateLimit } from "../lib/rateLimiter.js";
import { hashRequestBody } from "../lib/idempotency.js";
import { newId } from "../lib/ids.js";
import { isUniqueViolation } from "../lib/dbErrors.js";
import { serializeBooking, type BookingRow } from "../lib/serialize.js";
import { decodeCursor, encodeCursor } from "../lib/pagination.js";

/**
 * `db.execute()` resolves to a driver-specific shape: the real Postgres
 * (`node-postgres`) driver returns `{ rows }`, while the pg-proxy driver used
 * in tests resolves straight to the row array. This normalizes both.
 */
async function execRows(db: Database, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = (await db.execute(query)) as unknown;
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  return (result as { rows: Record<string, unknown>[] }).rows;
}

function rowToBooking(row: Record<string, unknown>): BookingRow {
  // Raw db.execute() results skip Drizzle's column mapping, and the real
  // `pg` driver (unlike the pg-mem proxy used in tests) hands back
  // timestamptz columns as Postgres's native text format (e.g.
  // "2026-11-14 23:22:08.538+00"), not a parsed Date — hence the explicit
  // `new Date(...)` instead of a same-shape cast.
  const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at as string);
  return {
    id: row.id as string,
    slotId: row.slot_id as string,
    name: row.name as string,
    email: row.email as string,
    status: row.status as "confirmed" | "cancelled",
    createdAt,
  };
}

export const bookingsRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Plain select() by primary key, with no .limit(1): id/key columns are
// primary keys so at most one row ever matches. (pg-mem — our in-process
// Postgres stand-in for tests — errors on a parameterized LIMIT combined
// with a primary-key lookup, so this also sidesteps that.)
async function findSlotById(db: Database, id: string) {
  const [row] = await db.select().from(slots).where(eq(slots.id, id));
  return row;
}

async function findBookingById(db: Database, id: string) {
  const [row] = await db.select().from(bookings).where(eq(bookings.id, id));
  return row;
}

async function findIdempotencyKey(db: Database, key: string) {
  const [row] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
  return row;
}

interface Outcome {
  status: number;
  body: Record<string, unknown>;
}

async function processBooking(db: Database, rawBody: unknown): Promise<Outcome> {
  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
    return { status: 400, body: { error: "request body must be a JSON object" } };
  }
  const { slot_id, name, email } = rawBody as Record<string, unknown>;

  const slotId = typeof slot_id === "string" ? slot_id.trim() : "";
  const trimmedName = typeof name === "string" ? name.trim() : "";
  const trimmedEmail = typeof email === "string" ? email.trim() : "";

  if (!slotId) return { status: 400, body: { error: "slot_id is required" } };
  if (!trimmedName) return { status: 400, body: { error: "name is required" } };
  if (!trimmedEmail) return { status: 400, body: { error: "email is required" } };
  if (!EMAIL_RE.test(trimmedEmail)) {
    return { status: 400, body: { error: "email is invalid" } };
  }

  const normalizedEmail = trimmedEmail.toLowerCase();

  const slot = await findSlotById(db, slotId);
  if (!slot) return { status: 404, body: { error: "slot not found" } };

  if (slot.start.getTime() <= Date.now()) {
    return { status: 400, body: { error: "slot has already started" } };
  }

  const bookingId = newId("bk");
  const createdAt = new Date();

  try {
    // A single statement with two writes: every Postgres statement is
    // implicitly its own transaction, so if the slot_locks insert hits the
    // slot_id primary key (meaning another request already holds this slot)
    // the whole statement — including the bookings insert — rolls back as
    // one unit. This is the atomic double-booking guard, enforced by the
    // database itself rather than by application-level locking.
    const rows = await execRows(
      db,
      sql`
        WITH new_booking AS (
          INSERT INTO ${bookings} (id, slot_id, name, email, status, created_at)
          VALUES (${bookingId}, ${slotId}, ${trimmedName}, ${normalizedEmail}, 'confirmed', ${createdAt})
          RETURNING *
        ), lock_slot AS (
          INSERT INTO ${slotLocks} (slot_id, booking_id)
          SELECT slot_id, id FROM new_booking
          RETURNING *
        )
        SELECT * FROM new_booking
      `,
    );

    return { status: 201, body: serializeBooking(rowToBooking(rows[0])) };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { status: 409, body: { error: "slot already booked" } };
    }
    throw err;
  }
}

bookingsRouter.post("/bookings", async (req, res) => {
  const db = getDb();
  const rawBody: unknown = req.body ?? {};
  const bodyEmail =
    typeof rawBody === "object" && rawBody !== null && "email" in rawBody
      ? (rawBody as Record<string, unknown>).email
      : undefined;
  const rateLimitKey =
    typeof bodyEmail === "string" && bodyEmail.trim()
      ? bodyEmail.trim().toLowerCase()
      : "__missing_email__";

  const rate = checkRateLimit(rateLimitKey);
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSeconds));
    res.status(429).json({ error: "too many attempts for this email, slow down" });
    return;
  }

  const idempotencyKey = req.header("Idempotency-Key");

  if (idempotencyKey) {
    const existing = await findIdempotencyKey(db, idempotencyKey);
    if (existing) {
      const currentHash = hashRequestBody(rawBody);
      if (currentHash !== existing.requestHash) {
        res
          .status(422)
          .json({ error: "Idempotency-Key was already used with a different request body" });
        return;
      }
      res.status(existing.statusCode).json(existing.responseBody as Record<string, unknown>);
      return;
    }
  }

  const outcome = await processBooking(db, rawBody);

  if (idempotencyKey) {
    const inserted = await db
      .insert(idempotencyKeys)
      .values({
        key: idempotencyKey,
        requestHash: hashRequestBody(rawBody),
        statusCode: outcome.status,
        responseBody: outcome.body,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted.length === 0) {
      // Another request raced us to store this key first; defer to its result
      // so both callers see the exact same response for this Idempotency-Key.
      const stored = await findIdempotencyKey(db, idempotencyKey);
      if (stored) {
        res.status(stored.statusCode).json(stored.responseBody as Record<string, unknown>);
        return;
      }
    }
  }

  res.status(outcome.status).json(outcome.body);
});

bookingsRouter.get("/bookings", async (req, res) => {
  const db = getDb();
  const emailParam = req.query.email;
  if (typeof emailParam !== "string" || !emailParam.trim()) {
    res.status(400).json({ error: "email query parameter is required" });
    return;
  }
  const email = emailParam.trim().toLowerCase();

  let limit = 10;
  if (req.query.limit !== undefined) {
    const raw = req.query.limit;
    const parsedLimit = typeof raw === "string" ? Number(raw) : NaN;
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) {
      res.status(400).json({ error: "limit must be an integer between 1 and 50" });
      return;
    }
    limit = parsedLimit;
  }

  let cursorCondition;
  if (typeof req.query.cursor === "string" && req.query.cursor) {
    const cursor = decodeCursor(req.query.cursor);
    if (!cursor) {
      res.status(400).json({ error: "invalid cursor" });
      return;
    }
    const cursorDate = new Date(cursor.createdAt);
    cursorCondition = or(
      gt(bookings.createdAt, cursorDate),
      and(eq(bookings.createdAt, cursorDate), gt(bookings.id, cursor.id)),
    );
  }

  const rows = await db
    .select()
    .from(bookings)
    .where(cursorCondition ? and(eq(bookings.email, email), cursorCondition) : eq(bookings.email, email))
    .orderBy(asc(bookings.createdAt), asc(bookings.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore
    ? encodeCursor({ createdAt: page[page.length - 1].createdAt.toISOString(), id: page[page.length - 1].id })
    : null;

  res.status(200).json({
    bookings: page.map(serializeBooking),
    next_cursor: nextCursor,
  });
});

bookingsRouter.get("/bookings/:id", async (req, res) => {
  const db = getDb();
  const booking = await findBookingById(db, req.params.id);
  if (!booking) {
    res.status(404).json({ error: "no booking with that id" });
    return;
  }
  res.status(200).json(serializeBooking(booking));
});

bookingsRouter.delete("/bookings/:id", async (req, res) => {
  const db = getDb();
  const id = req.params.id;

  const booking = await findBookingById(db, id);
  if (!booking) {
    res.status(404).json({ error: "no booking with that id" });
    return;
  }
  if (booking.status === "cancelled") {
    res.status(409).json({ error: "booking is already cancelled" });
    return;
  }

  // Same single-statement-is-atomic trick as booking creation: the
  // conditional UPDATE only matches (and the slot_locks row only gets
  // freed) if the booking was still confirmed at the instant this runs,
  // so a concurrent double-cancel can only ever free the slot once.
  const rows = await execRows(
    db,
    sql`
      WITH cancelled AS (
        UPDATE ${bookings} SET status = 'cancelled'
        WHERE id = ${id} AND status = 'confirmed'
        RETURNING *
      ), freed AS (
        DELETE FROM ${slotLocks}
        WHERE booking_id IN (SELECT id FROM cancelled)
        RETURNING *
      )
      SELECT * FROM cancelled
    `,
  );

  if (rows.length === 0) {
    // Lost a race with a concurrent cancellation of the same booking.
    res.status(409).json({ error: "booking is already cancelled" });
    return;
  }

  res.status(200).json(serializeBooking(rowToBooking(rows[0])));
});
