import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * Applies the hand-maintained SQL migration file against a real Postgres pool.
 * Tests apply the same statements directly against pg-mem instead (see
 * tests/setup.ts) since pg-mem isn't a `pg.Pool`.
 */
export async function runMigrations(pool: Pool): Promise<void> {
  for (const statement of readMigrationStatements()) {
    await pool.query(statement);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
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
