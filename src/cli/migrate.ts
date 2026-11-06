import { migrate } from "../adapters/db/migrate.js";
import { createPool } from "../adapters/db/pool.js";
import { loadDotenv } from "../config/dotenv.js";
import { loadEnv } from "../config/env.js";

async function main(): Promise<void> {
  loadDotenv();
  const env = loadEnv();
  const pool = createPool(env.databaseUrl);

  try {
    const applied = await migrate(pool, "migrations");
    const summary = applied.length === 0 ? "already up to date" : `applied ${applied.join(", ")}`;
    console.log(JSON.stringify({ level: "info", msg: `migrations ${summary}` }));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ level: "error", msg: "migration failed", error: `${error}` }));
  process.exit(1);
});
