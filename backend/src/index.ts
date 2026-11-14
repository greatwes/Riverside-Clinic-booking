import "dotenv/config";
import { createApp } from "./app.js";
import { getPool } from "./db/client.js";
import { runMigrations } from "./db/runMigrations.js";

const port = Number(process.env.PORT ?? 3000);

async function main() {
  await runMigrations(getPool());

  const app = createApp();
  app.listen(port, () => {
    console.log(`Clinic booking API listening on port ${port}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
