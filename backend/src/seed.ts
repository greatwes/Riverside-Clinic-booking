import "dotenv/config";
import { getDb, getPool, closeDb } from "./db/client.js";
import { runMigrations } from "./db/runMigrations.js";
import { slots, bookings, slotLocks, idempotencyKeys } from "./db/schema.js";

const PROVIDERS = ["Dr Ade", "Dr Chidinma", "Dr Musa", "Dr Ngozi", "Dr Tunde", "Dr Amara"];
const SLOT_MINUTES = 30;
const DAYS_AHEAD = 7;
const DAY_START_HOUR = 9;
const DAY_END_HOUR = 17;

function buildSlots() {
  const generated: { id: string; provider: string; start: Date; end: Date }[] = [];
  const now = new Date();

  for (let dayOffset = 1; dayOffset <= DAYS_AHEAD; dayOffset++) {
    const day = new Date(now);
    day.setUTCDate(day.getUTCDate() + dayOffset);
    const dayOfWeek = day.getUTCDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) continue; // skip weekends

    for (const provider of PROVIDERS) {
      for (let hour = DAY_START_HOUR; hour < DAY_END_HOUR; hour++) {
        for (let minute = 0; minute < 60; minute += SLOT_MINUTES) {
          const start = new Date(
            Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute, 0),
          );
          const end = new Date(start.getTime() + SLOT_MINUTES * 60_000);
          const id = `s_${start.toISOString().replace(/[-:.]/g, "")}_${provider.replace(/\s+/g, "").toLowerCase()}`;
          generated.push({ id, provider, start, end });
        }
      }
    }
  }
  return generated;
}

async function main() {
  const pool = getPool();
  await runMigrations(pool);
  const db = getDb();

  const generated = buildSlots();

  await db.transaction(async (tx) => {
    await tx.delete(idempotencyKeys);
    await tx.delete(slotLocks);
    await tx.delete(bookings);
    await tx.delete(slots);
    await tx.insert(slots).values(generated);
  });

  console.log(`Seeded ${generated.length} slots across ${PROVIDERS.length} providers for the next ${DAYS_AHEAD} days.`);
  await closeDb();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
