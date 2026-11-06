import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getAccount } from "../../src/adapters/db/accounts.js";
import { postMovement } from "../../src/application/post-movement.js";
import { systemClock } from "../../src/config/clock.js";
import { DomainError } from "../../src/domain/errors.js";
import { connectTestDatabase, createTenantFixture, truncateAll } from "./helpers.js";

let pool: Pool;

beforeAll(async () => {
  pool = await connectTestDatabase();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
});

describe("posting movements", () => {
  it("posts a balanced credit pair and updates the cached balance", async () => {
    const { tenantId, accountId } = await createTenantFixture(pool);

    const result = await postMovement(
      { db: pool, clock: systemClock },
      {
        tenantId,
        accountId,
        direction: "credit",
        type: "credit_transfer",
        amountMinor: 125_000n,
        reference: "DEP-2026-000123",
        remitter: { name: "GULF TRADING LLC", bic: "EBILAEAD" },
        valueDate: "2026-11-05",
        actor: "test",
      },
    );

    expect(result.transaction.status).toBe("posted");
    expect(result.transaction.valueDate).toBe("2026-11-05");
    expect(result.balance.ledgerMinor).toBe(125_000n);
    expect(result.balance.availableMinor).toBe(125_000n);

    const entries = await pool.query<{
      direction: string;
      ledger_account: string;
      amount_minor: string;
    }>(
      "SELECT direction, ledger_account, amount_minor FROM ledger_entries WHERE transaction_id = $1 ORDER BY direction",
      [result.transaction.id],
    );
    expect(entries.rows).toHaveLength(2);
    expect(entries.rows.map((row) => row.direction).sort()).toEqual(["C", "D"]);
    expect(entries.rows.reduce((total, row) => total + BigInt(row.amount_minor), 0n)).toBe(
      250_000n,
    );

    const customerLeg = await pool.query<{ balance_after_minor: string }>(
      "SELECT balance_after_minor FROM ledger_entries WHERE transaction_id = $1 AND ledger_account = 'customer_deposit'",
      [result.transaction.id],
    );
    expect(customerLeg.rows[0]?.balance_after_minor).toBe("125000");

    const stored = await getAccount(pool, tenantId, accountId);
    expect(stored?.balance.ledgerMinor).toBe(125_000n);
    expect(stored?.balance.version).toBe(1n);

    const audit = await pool.query("SELECT 1 FROM audit_log WHERE entity_id = $1", [
      result.transaction.id,
    ]);
    expect(audit.rowCount).toBe(1);
  });

  it("accumulates credits and allows a debit within available funds", async () => {
    const { tenantId, accountId } = await createTenantFixture(pool);
    const post = (direction: "credit" | "debit", amountMinor: bigint) =>
      postMovement(
        { db: pool, clock: systemClock },
        {
          tenantId,
          accountId,
          direction,
          type: direction === "credit" ? "credit_transfer" : "payout",
          amountMinor,
          actor: "test",
        },
      );

    await post("credit", 250_000n);
    await post("credit", 125_000n);
    const afterDebit = await post("debit", 40_000n);

    expect(afterDebit.balance.ledgerMinor).toBe(335_000n);
    expect(afterDebit.balance.availableMinor).toBe(335_000n);
  });

  it("refuses a debit beyond available funds and leaves no partial rows", async () => {
    const { tenantId, accountId } = await createTenantFixture(pool);

    await expect(
      postMovement(
        { db: pool, clock: systemClock },
        {
          tenantId,
          accountId,
          direction: "debit",
          type: "payout",
          amountMinor: 1n,
          actor: "test",
        },
      ),
    ).rejects.toBeInstanceOf(DomainError);

    const transactions = await pool.query("SELECT count(*)::int AS count FROM transactions");
    expect(transactions.rows[0]?.count).toBe(0);
    const balance = await getAccount(pool, tenantId, accountId);
    expect(balance?.balance.ledgerMinor).toBe(0n);
  });

  it("refuses to post to a restricted account", async () => {
    const { tenantId, accountId } = await createTenantFixture(pool);
    await pool.query("UPDATE accounts SET status = 'restricted' WHERE id = $1", [accountId]);

    await expect(
      postMovement(
        { db: pool, clock: systemClock },
        {
          tenantId,
          accountId,
          direction: "credit",
          type: "credit_transfer",
          amountMinor: 100n,
          actor: "test",
        },
      ),
    ).rejects.toMatchObject({ code: "account_restricted" });
  });

  it("hides an account from another tenant", async () => {
    const first = await createTenantFixture(pool);
    const second = await createTenantFixture(pool);

    await expect(
      postMovement(
        { db: pool, clock: systemClock },
        {
          tenantId: second.tenantId,
          accountId: first.accountId,
          direction: "credit",
          type: "credit_transfer",
          amountMinor: 100n,
          actor: "test",
        },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps the ledger balanced and serializes concurrent postings", async () => {
    const { tenantId, accountId } = await createTenantFixture(pool);

    await Promise.all(
      Array.from({ length: 10 }, () =>
        postMovement(
          { db: pool, clock: systemClock },
          {
            tenantId,
            accountId,
            direction: "credit",
            type: "credit_transfer",
            amountMinor: 10_000n,
            actor: "test",
          },
        ),
      ),
    );

    const totals = await pool.query<{ debits: string; credits: string; entries: string }>(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'D' THEN amount_minor END), 0) AS debits,
         COALESCE(SUM(CASE WHEN direction = 'C' THEN amount_minor END), 0) AS credits,
         count(*) AS entries
       FROM ledger_entries`,
    );
    expect(totals.rows[0]?.debits).toBe("100000");
    expect(totals.rows[0]?.credits).toBe("100000");
    expect(totals.rows[0]?.entries).toBe("20");

    const stored = await getAccount(pool, tenantId, accountId);
    expect(stored?.balance.ledgerMinor).toBe(100_000n);
    expect(stored?.balance.availableMinor).toBe(100_000n);
    expect(stored?.balance.version).toBe(10n);

    const cached = await pool.query<{ ledger_minor: string; available_minor: string }>(
      "SELECT b.ledger_minor, b.available_minor FROM account_balances b WHERE b.account_id = $1",
      [accountId],
    );
    const derived = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'C' THEN amount_minor ELSE -amount_minor END), 0) AS total
         FROM ledger_entries WHERE ledger_account = 'customer_deposit' AND account_id = $1`,
      [accountId],
    );
    expect(cached.rows[0]?.ledger_minor).toBe(derived.rows[0]?.total);
  });
});
