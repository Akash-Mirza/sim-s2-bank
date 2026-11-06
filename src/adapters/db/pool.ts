import { Pool } from "pg";

export function createPool(databaseUrl: string): Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on("error", (error) => {
    console.error(
      JSON.stringify({ level: "error", msg: "idle postgres client error", error: `${error}` }),
    );
  });

  return pool;
}
