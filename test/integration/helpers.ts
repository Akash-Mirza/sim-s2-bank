import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { migrate } from "../../src/adapters/db/migrate.js";
import { createPool } from "../../src/adapters/db/pool.js";
import { createTenant } from "../../src/adapters/db/tenants.js";
import { createAccount } from "../../src/application/create-account.js";

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url === "") {
    throw new Error(
      "TEST_DATABASE_URL is required for integration tests (see compose.yaml postgres service)",
    );
  }
  if (!/test/i.test(url)) {
    throw new Error("TEST_DATABASE_URL must point at a test database");
  }
  return url;
}

export async function connectTestDatabase(): Promise<Pool> {
  const pool = createPool(testDatabaseUrl());
  await migrate(pool, "migrations");
  return pool;
}

export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(
    `TRUNCATE audit_log, ledger_entries, transactions, account_balances,
              accounts, api_keys, tenants, idempotency_keys RESTART IDENTITY CASCADE`,
  );
}

export async function createTenantFixture(
  pool: Pool,
): Promise<{ tenantId: string; accountId: string; iban: string }> {
  const tenant = await createTenant(pool, {
    code: `t-${randomUUID().slice(0, 8)}`,
    legalName: "TEST TRADING LLC",
  });
  const account = await createAccount(pool, { tenantId: tenant.id, actor: "test" });
  return { tenantId: tenant.id, accountId: account.id, iban: account.iban };
}
