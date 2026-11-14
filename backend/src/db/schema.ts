import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";

export const slots = pgTable("slots", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  start: timestamp("start", { withTimezone: true, mode: "date" }).notNull(),
  end: timestamp("end", { withTimezone: true, mode: "date" }).notNull(),
});

export const bookings = pgTable("bookings", {
  id: text("id").primaryKey(),
  slotId: text("slot_id")
    .notNull()
    .references(() => slots.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  status: text("status", { enum: ["confirmed", "cancelled"] }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

/**
 * One row per slot that currently has an active (confirmed) booking.
 * Its primary key is the atomic double-booking guard: two transactions
 * racing to book the same slot_id can only ever have one of them succeed
 * inserting here, so the loser gets a unique-violation we turn into 409.
 * Cancelling a booking deletes its row, freeing the slot again.
 */
export const slotLocks = pgTable("slot_locks", {
  slotId: text("slot_id")
    .primaryKey()
    .references(() => slots.id, { onDelete: "cascade" }),
  bookingId: text("booking_id").notNull(),
});

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  requestHash: text("request_hash").notNull(),
  statusCode: integer("status_code").notNull(),
  responseBody: jsonb("response_body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});
