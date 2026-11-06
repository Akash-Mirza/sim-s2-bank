import { getAccount } from "../adapters/db/accounts.js";
import { createPool } from "../adapters/db/pool.js";
import { createApiKey, createTenant } from "../adapters/db/tenants.js";
import { createAccount } from "../application/create-account.js";
import { postMovement } from "../application/post-movement.js";
import { systemClock } from "../config/clock.js";
import { loadDotenv } from "../config/dotenv.js";
import { loadEnv } from "../config/env.js";

const TENANT_CODE = "demo-bank-client";

async function main(): Promise<void> {
  loadDotenv();
  const env = loadEnv();
  const pool = createPool(env.databaseUrl);

  try {
    const existingTenant = await pool.query<{ id: string }>(
      "SELECT id FROM tenants WHERE code = $1",
      [TENANT_CODE],
    );

    const tenant =
      existingTenant.rows[0] === undefined
        ? await createTenant(pool, { code: TENANT_CODE, legalName: "GULF TRADING LLC" })
        : { id: existingTenant.rows[0].id, code: TENANT_CODE };

    const accounts = await pool.query<{ id: string }>(
      "SELECT id FROM accounts WHERE tenant_id = $1 ORDER BY opened_at ASC LIMIT 1",
      [tenant.id],
    );

    const account =
      accounts.rows[0] === undefined
        ? await createAccount(pool, {
            tenantId: tenant.id,
            actor: "seed",
            requestId: "seed",
          })
        : (await getAccount(pool, tenant.id, accounts.rows[0].id))?.account;

    if (account === undefined) throw new Error("seed could not resolve an account");

    const keyCount = await pool.query<{ count: string }>(
      "SELECT count(*)::bigint AS count FROM api_keys WHERE tenant_id = $1",
      [tenant.id],
    );
    const issued =
      keyCount.rows[0] !== undefined && BigInt(keyCount.rows[0].count) > 0n
        ? null
        : await createApiKey(pool, { tenantId: tenant.id, pepper: env.apiKeyPepper });

    const alreadyPosted = await pool.query<{ count: string }>(
      "SELECT count(*)::bigint AS count FROM transactions WHERE account_id = $1",
      [account.id],
    );
    const empty = alreadyPosted.rows[0] !== undefined && BigInt(alreadyPosted.rows[0].count) === 0n;

    if (empty) {
      const demoMovements = [
        { direction: "credit" as const, amountMinor: 250_000n, reference: "DEP-2026-000101" },
        { direction: "credit" as const, amountMinor: 125_000n, reference: "DEP-2026-000102" },
        { direction: "debit" as const, amountMinor: 40_000n, reference: "PAY-2026-000103" },
      ];
      for (const movement of demoMovements) {
        await postMovement(
          { db: pool, clock: systemClock },
          {
            tenantId: tenant.id,
            accountId: account.id,
            direction: movement.direction,
            type: movement.direction === "credit" ? "credit_transfer" : "payout",
            amountMinor: movement.amountMinor,
            reference: movement.reference,
            remitter:
              movement.direction === "credit"
                ? { name: "GULF TRADING LLC", bic: "EBILAEAD" }
                : undefined,
            actor: "seed",
            requestId: "seed",
          },
        );
      }
    }

    const balance = await getAccount(pool, tenant.id, account.id);
    console.log(
      JSON.stringify(
        {
          level: "info",
          msg: "seed complete",
          tenant: tenant.code,
          account: {
            id: account.id,
            iban: account.iban,
            bic: account.bic,
          },
          api_key: issued?.key ?? "existing key not re-printed",
          balance: balance?.balance,
        },
        (_key, value) => (typeof value === "bigint" ? value.toString() : value),
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ level: "error", msg: "seed failed", error: `${error}` }));
  process.exit(1);
});
