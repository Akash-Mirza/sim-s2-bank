"use strict";
const { migrate } = require("../dist/adapters/db/migrate.js");
const { createPool } = require("../dist/adapters/db/pool.js");
const dbUrl = process.env.DATABASE_URL || "postgres://sim_s2:sim_s2@localhost:5435/sim_s2";
const pool = createPool(dbUrl);
(async () => {
  try {
    const applied = await migrate(pool, "migrations");
    const summary = applied.length === 0 ? "already up to date" : `applied ${applied.join(", ")}`;
    console.log(JSON.stringify({ level: "info", msg: `migrations ${summary}` }));
  } finally {
    await pool.end();
  }
})().catch((err) => {
  console.error(JSON.stringify({ level: "error", msg: "migration failed", error: String(err) }));
  process.exit(1);
});
