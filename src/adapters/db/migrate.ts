import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";

/** Session-scoped lock so two replicas or two test files cannot race a migration. */
const MIGRATION_LOCK_KEY = 927_001;

/**
 * Apply every unapplied *.sql file in order, one transaction per file.
 * Runs as its own job so replicas never race on boot.
 */
export async function migrate(pool: Pool, directory = "migrations"): Promise<string[]> {
  const files = readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const applied: string[] = [];
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );

    for (const file of files) {
      const existing = await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", [file]);
      if ((existing.rowCount ?? 0) > 0) continue;

      const sql = readFileSync(join(directory, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }

    return applied;
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    client.release();
  }
}

export async function currentSchemaVersion(pool: Pool): Promise<string | null> {
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1",
  );
  return result.rows[0]?.id ?? null;
}
