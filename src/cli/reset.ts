import { migrate } from "../adapters/db/migrate.js";
import { createPool } from "../adapters/db/pool.js";
import { loadDotenv } from "../config/dotenv.js";
import { loadEnv } from "../config/env.js";

async function main(): Promise<void> {
  loadDotenv();
  const env = loadEnv();

  if (env.nodeEnv === "production") {
    throw new Error("reset refuses to run with NODE_ENV=production");
  }

  const pool = createPool(env.databaseUrl);
  try {
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await pool.query("CREATE SCHEMA public");
    const applied = await migrate(pool, "migrations");
    console.log(JSON.stringify({ level: "info", msg: "database reset", applied }));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ level: "error", msg: "reset failed", error: `${error}` }));
  process.exit(1);
});
