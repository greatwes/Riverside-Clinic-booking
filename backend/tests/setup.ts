import { newDb } from "pg-mem";
import { drizzle } from "drizzle-orm/pg-proxy";
import { setTestDatabase, getDb, type Database } from "../src/db/client.js";
import { readMigrationStatements } from "../src/db/runMigrations.js";
import { createApp } from "../src/app.js";
import { resetRateLimiter } from "../src/lib/rateLimiter.js";
import { slots } from "../src/db/schema.js";
import * as schema from "../src/db/schema.js";

process.env.API_KEY ??= "test-api-key";

export const API_KEY = process.env.API_KEY;

/**
 * Spins up a fresh in-process, Postgres-compatible database (pg-mem) and an
 * Express app wired to it, via Drizzle's `pg-proxy` driver. pg-mem is a
 * pure-JS engine, so this environment needs no Docker/local Postgres install
 * to run the full test suite — including the real atomic-write SQL (CTEs,
 * unique constraints, ON CONFLICT) the app uses in production against a real
 * Postgres (Neon/Supabase). We use pg-proxy rather than the usual
 * `node-postgres` driver because Drizzle's node-postgres session always
 * requests a raw-mode query result that pg-mem's `pg`-compatible shim
 * doesn't implement; pg-proxy talks to pg-mem directly instead.
 */
/** Minimal SQL literal escaping, test-only (see note on `interpolate` below). */
function toSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return `'${value.toISOString()}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * pg-mem has a bug where a bound parameter (`.prepare(sql).bind(params)`)
 * filtering on an indexed/primary-key column throws "No execution context
 * available" — confirmed against pg-mem 3.0.14 directly; the identical query
 * with the value inlined as a literal works fine. Since this is test-only,
 * trusted, app-generated SQL (never raw user input), inlining parameters as
 * escaped literals and running them through pg-mem's plain `query()` sidesteps
 * the bug entirely.
 */
function interpolate(sqlText: string, params: unknown[]): string {
  return sqlText.replace(/\$(\d+)/g, (_match, n: string) => toSqlLiteral(params[Number(n) - 1]));
}

export async function createTestContext() {
  const mem = newDb();

  for (const statement of readMigrationStatements()) {
    mem.public.query(statement);
  }

  const db: Database = drizzle(async (sqlText, params, method) => {
    try {
      const result = mem.public.query(interpolate(sqlText, params));
      // Drizzle calls with method "all" for query-builder calls (select/
      // insert().returning()/etc) and maps the result itself — it expects
      // rows as arrays indexed in column order (the same shape the real
      // `pg` driver gives it under `rowMode: "array"`), not the named
      // objects pg-mem returns natively. Method "execute" (db.execute(sql))
      // skips that mapping and hands rows straight to application code, so
      // those should stay as named objects.
      const rows =
        method === "all"
          ? result.rows.map((row) => result.fields.map((field) => row[field.name]))
          : result.rows;
      return { rows };
    } catch (err) {
      // pg-mem reports unique_violation as a numeric code; normalize it to
      // match what the real `pg` driver sends in production.
      if (err && typeof err === "object" && "code" in err) {
        (err as { code: unknown }).code = String((err as { code: unknown }).code);
      }
      throw err;
    }
  }, { schema });

  setTestDatabase(db);
  resetRateLimiter();

  const app = createApp();

  return { app, db: getDb(), mem };
}

export async function seedSlots(
  db: ReturnType<typeof getDb>,
  rows: { id: string; provider: string; start: Date; end: Date }[],
) {
  await db.insert(slots).values(rows);
}

export function futureSlot(id = "s1", provider = "Dr Ade", hoursFromNow = 24) {
  const start = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return { id, provider, start, end };
}

export function pastSlot(id = "s_past", provider = "Dr Ade") {
  const start = new Date(Date.now() - 60 * 60 * 1000);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return { id, provider, start, end };
}
