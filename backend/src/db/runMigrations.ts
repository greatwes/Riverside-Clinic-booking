import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { getPool } from "./client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function readMigrationStatements(): string[] {
  const sqlPath = join(__dirname, "..", "..", "drizzle", "0000_init.sql");
  const raw = readFileSync(sqlPath, "utf8");
  return raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Postgres duplicate_object: e.g. an ADD CONSTRAINT that already exists. */
function isDuplicateObject(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "42710";
}

/**
 * Applies the hand-maintained SQL migration file against a real Postgres pool.
 * Tests apply the same statements directly against pg-mem instead (see
 * tests/setup.ts) since pg-mem isn't a `pg.Pool`.
 *
 * The app re-runs this on every boot (see src/index.ts), so it has to be safe
 * to apply twice. CREATE TABLE/INDEX already guard themselves with
 * IF NOT EXISTS; Postgres has no equivalent for ADD CONSTRAINT, so a second
 * run's constraint statements are expected to fail with "already exists"
 * (42710) and are swallowed here instead.
 */
export async function runMigrations(pool: Pool): Promise<void> {
  for (const statement of readMigrationStatements()) {
    try {
      await pool.query(statement);
    } catch (err) {
      if (!isDuplicateObject(err)) throw err;
    }
  }
}

// Comparing raw strings (`file://${process.argv[1]}`) breaks on Windows: a
// path like `C:\foo\bar.ts` doesn't stringify into the same form as the
// `file:///C:/foo/bar.ts` that import.meta.url actually produces.
// pathToFileURL normalizes both sides the same way.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrations(getPool())
    .then(() => {
      console.log("Migrations applied.");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}
