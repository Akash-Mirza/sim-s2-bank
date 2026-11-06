import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApiKey, createTenant } from "../../src/adapters/db/tenants.js";
import { createAccount } from "../../src/application/create-account.js";
import { postMovement } from "../../src/application/post-movement.js";
import { systemClock } from "../../src/config/clock.js";
import type { Env } from "../../src/config/env.js";
import { buildUaeIban } from "../../src/domain/iban.js";
import { buildServer } from "../../src/http/server.js";
import { connectTestDatabase, testDatabaseUrl, truncateAll } from "./helpers.js";

const PEPPER = "integration-test-pepper-0123456789";
const OPS_TOKEN = "integration-ops-token";
const BENEFICIARY_IBAN = buildUaeIban("033", "1234567890123456");

let pool: Pool;
let app: FastifyInstance;
let authorization: string;
let tenantId: string;
let accountId: string;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    databaseUrl: testDatabaseUrl(),
    logLevel: "silent",
    simClock: undefined,
    enableDevOps: true,
    opsDevToken: OPS_TOKEN,
    apiKeyPepper: PEPPER,
    version: "0.2.0-test",
    gitCommit: "test",
    ...overrides,
  };
}

beforeAll(async () => {
  pool = await connectTestDatabase();
  app = buildServer(makeEnv());
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
  const tenant = await createTenant(pool, { code: "payout-test", legalName: "PAYOUT TEST LLC" });
  tenantId = tenant.id;
  const key = await createApiKey(pool, { tenantId, pepper: PEPPER });
  authorization = `Bearer ${key.key}`;
  const account = await createAccount(pool, { tenantId, actor: "test" });
  accountId = account.id;

  await postMovement(
    { db: pool, clock: systemClock },
    {
      tenantId,
      accountId,
      direction: "credit",
      type: "credit_transfer",
      amountMinor: 100_000n,
      reference: "DEP-OPENING",
      actor: "test",
    },
  );
});

function createPayout(
  key: string,
  amount = "250.00",
  extra: Record<string, unknown> = {},
  instance: FastifyInstance = app,
) {
  return instance.inject({
    method: "POST",
    url: "/v1/payouts",
    headers: { authorization, "idempotency-key": key },
    payload: {
      account_id: accountId,
      amount,
      reference: "INV-2026-0042",
      beneficiary: {
        name: "GULF SUPPLIES LLC",
        iban: BENEFICIARY_IBAN,
        bic: "EBILAEAD",
      },
      ...extra,
    },
  });
}

function advance(payoutId: string, key: string, to?: string) {
  return app.inject({
    method: "POST",
    url: `/ops/v1/payouts/${payoutId}/advance`,
    headers: { "x-ops-token": OPS_TOKEN, "idempotency-key": key },
    payload: to === undefined ? {} : { to },
  });
}

async function balance() {
  const response = await app.inject({
    method: "GET",
    url: `/v1/accounts/${accountId}/balance`,
    headers: { authorization },
  });
  return response.json().balance as {
    available: string;
    pending: string;
    held: string;
    ledger: string;
  };
}

describe("payouts and holds", () => {
  it("reserves available balance with a hold without touching the ledger", async () => {
    const response = await createPayout("pay-1");
    expect(response.statusCode).toBe(201);
    const body = response.json();

    expect(body.payout.status).toBe("created");
    expect(body.payout.beneficiary.iban).toBe(BENEFICIARY_IBAN);
    expect(body.balance).toEqual({
      available: "750.00",
      pending: "0.00",
      held: "250.00",
      ledger: "1000.00",
    });

    const holds = await pool.query<{ status: string; amount_minor: string }>(
      "SELECT status, amount_minor FROM holds",
    );
    expect(holds.rowCount).toBe(1);
    expect(holds.rows[0]?.status).toBe("active");
    expect(holds.rows[0]?.amount_minor).toBe("25000");

    const transactions = await pool.query("SELECT count(*)::int AS count FROM transactions");
    expect(transactions.rows[0]?.count).toBe(1);
  });

  it("settles by posting the debit and capturing the hold", async () => {
    const created = await createPayout("pay-2");
    const payoutId = created.json().payout.id;

    const first = await advance(payoutId, "adv-1");
    expect(first.statusCode).toBe(200);
    expect(first.json().payout.status).toBe("validated");

    for (const [index, step] of ["submitted", "accepted", "settled"].entries()) {
      const response = await advance(payoutId, `adv-${index + 2}`, step);
      expect(response.statusCode, step).toBe(200);
    }

    const detail = await app.inject({
      method: "GET",
      url: `/v1/payouts/${payoutId}`,
      headers: { authorization },
    });
    expect(detail.json().payout.status).toBe("settled");
    expect(detail.json().payout.transaction_id).toBeTruthy();
    expect(detail.json().events.map((event: { to_status: string }) => event.to_status)).toEqual([
      "created",
      "validated",
      "submitted",
      "accepted",
      "settled",
    ]);

    expect(await balance()).toEqual({
      available: "750.00",
      pending: "0.00",
      held: "0.00",
      ledger: "750.00",
    });

    const hold = await pool.query<{ status: string; captured_transaction_id: string }>(
      "SELECT status, captured_transaction_id FROM holds",
    );
    expect(hold.rows[0]?.status).toBe("captured");
    expect(hold.rows[0]?.captured_transaction_id).toBe(detail.json().payout.transaction_id);

    const entries = await pool.query<{ direction: string; balance_after_minor: string | null }>(
      "SELECT direction, balance_after_minor FROM ledger_entries WHERE transaction_id = $1 ORDER BY direction",
      [detail.json().payout.transaction_id],
    );
    expect(entries.rowCount).toBe(2);
    const customerLeg = entries.rows.find((row) => row.direction === "D");
    expect(customerLeg?.balance_after_minor).toBe("75000");
  });

  it("refuses an illegal transition with 409 and leaves the payout alone", async () => {
    const created = await createPayout("pay-3");
    const payoutId = created.json().payout.id;

    const jump = await advance(payoutId, "adv-jump", "settled");
    expect(jump.statusCode).toBe(409);
    expect(jump.json().error.code).toBe("invalid_state_transition");
    expect(jump.json().error.details).toMatchObject({ from: "created", to: "settled" });

    const detail = await app.inject({
      method: "GET",
      url: `/v1/payouts/${payoutId}`,
      headers: { authorization },
    });
    expect(detail.json().payout.status).toBe("created");
    expect((await balance()).held).toBe("250.00");
  });

  it("cancels before submission and releases the hold", async () => {
    const created = await createPayout("pay-4");
    const payoutId = created.json().payout.id;

    const cancelled = await app.inject({
      method: "POST",
      url: `/v1/payouts/${payoutId}/cancel`,
      headers: { authorization, "idempotency-key": "cancel-1" },
      payload: {},
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().payout.status).toBe("cancelled");
    expect(cancelled.json().balance).toEqual({
      available: "1000.00",
      pending: "0.00",
      held: "0.00",
      ledger: "1000.00",
    });
  });

  it("replays a payout creation instead of reserving twice", async () => {
    const first = await createPayout("pay-replay");
    const second = await createPayout("pay-replay");

    expect(second.statusCode).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.json().payout.id).toBe(first.json().payout.id);

    const payouts = await pool.query("SELECT count(*)::int AS count FROM payouts");
    expect(payouts.rows[0]?.count).toBe(1);
    const holds = await pool.query("SELECT count(*)::int AS count FROM holds");
    expect(holds.rows[0]?.count).toBe(1);
    expect((await balance()).held).toBe("250.00");
  });

  it("creates and releases an explicit hold, replaying the release", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/v1/accounts/${accountId}/holds`,
      headers: { authorization, "idempotency-key": "hold-1" },
      payload: { amount: "100.00", reason: "sanctions review", reference: "CASE-9" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().hold.status).toBe("active");
    expect(created.json().balance.available).toBe("900.00");

    const listed = await app.inject({
      method: "GET",
      url: `/v1/accounts/${accountId}/holds`,
      headers: { authorization },
    });
    expect(listed.json().data).toHaveLength(1);

    const holdId = created.json().hold.id;
    const released = await app.inject({
      method: "DELETE",
      url: `/v1/holds/${holdId}`,
      headers: { authorization, "idempotency-key": "hold-release-1" },
    });
    expect(released.statusCode).toBe(200);
    expect(released.json().hold.status).toBe("released");
    expect(released.json().balance.available).toBe("1000.00");
    expect(released.json().balance.held).toBe("0.00");

    const replay = await app.inject({
      method: "DELETE",
      url: `/v1/holds/${holdId}`,
      headers: { authorization, "idempotency-key": "hold-release-1" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
  });

  it("refuses a hold larger than available balance", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/accounts/${accountId}/holds`,
      headers: { authorization, "idempotency-key": "hold-too-big" },
      payload: { amount: "2000.00", reason: "too much" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("insufficient_funds");
    expect((await balance()).held).toBe("0.00");
  });

  it("rejects an invalid beneficiary IBAN without reserving funds", async () => {
    const response = await createPayout("pay-bad-iban", "10.00", {
      beneficiary: { name: "NOBODY", iban: "AE000000000000000000000" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("invalid_iban");

    const payouts = await pool.query("SELECT count(*)::int AS count FROM payouts");
    expect(payouts.rows[0]?.count).toBe(0);
    expect((await balance()).available).toBe("1000.00");
  });

  it("requires the payouts:write scope", async () => {
    const readOnly = await createApiKey(pool, {
      tenantId,
      pepper: PEPPER,
      scopes: ["accounts:read"],
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/payouts",
      headers: {
        authorization: `Bearer ${readOnly.key}`,
        "idempotency-key": "pay-scope",
      },
      payload: {
        account_id: accountId,
        amount: "1.00",
        beneficiary: { name: "X", iban: BENEFICIARY_IBAN },
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("forbidden");
  });

  it("rolls a payout after cut-off to the next business day", async () => {
    const frozen = buildServer(makeEnv({ simClock: "2026-11-05T12:30:00.000Z" }));
    await frozen.ready();
    try {
      const scheduleResponse = await createPayout("pay-frozen-1", "10.00", {}, frozen);
      expect(scheduleResponse.statusCode).toBe(201);
      expect(scheduleResponse.json().payout.scheduled_for).toBe("2026-11-06");
      expect(scheduleResponse.json().payout.cutoff_at).toBe("2026-11-06T11:00:00.000Z");

      const sameDay = await createPayout(
        "pay-frozen-2",
        "10.00",
        { value_date: "2026-11-05" },
        frozen,
      );
      expect(sameDay.statusCode).toBe(422);
      expect(sameDay.json().error.code).toBe("cutoff_passed");
    } finally {
      await frozen.close();
    }
  });

  it("returns settled funds with a reversal credit", async () => {
    const created = await createPayout("pay-reverse");
    const payoutId = created.json().payout.id;
    for (const [index, step] of ["validated", "submitted", "accepted", "settled"].entries()) {
      const response = await advance(payoutId, `rev-adv-${index}`, step);
      expect(response.statusCode).toBe(200);
    }

    const reversed = await app.inject({
      method: "POST",
      url: `/ops/v1/payouts/${payoutId}/reverse`,
      headers: { "x-ops-token": OPS_TOKEN, "idempotency-key": "reverse-1" },
      payload: {},
    });
    expect(reversed.statusCode).toBe(200);
    expect(reversed.json().payout.status).toBe("returned");
    expect(reversed.json().balance).toEqual({
      available: "1000.00",
      pending: "0.00",
      held: "0.00",
      ledger: "1000.00",
    });

    const detail = await app.inject({
      method: "GET",
      url: `/v1/payouts/${payoutId}`,
      headers: { authorization },
    });
    expect(detail.json().payout.failure_code).toBe("returned_after_settlement");

    const reversal = await pool.query<{ reversal_of: string | null }>(
      "SELECT reversal_of FROM transactions WHERE type = 'reversal'",
    );
    expect(reversal.rowCount).toBe(1);
    expect(reversal.rows[0]?.reversal_of).toBe(detail.json().payout.transaction_id);
  });

  it("lists payouts filtered by status", async () => {
    const first = await createPayout("pay-list-1");
    await createPayout("pay-list-2");
    await app.inject({
      method: "POST",
      url: `/v1/payouts/${first.json().payout.id}/cancel`,
      headers: { authorization, "idempotency-key": "pay-list-cancel" },
      payload: {},
    });

    const created = await app.inject({
      method: "GET",
      url: "/v1/payouts?status=created",
      headers: { authorization },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().data).toHaveLength(1);

    const all = await app.inject({
      method: "GET",
      url: "/v1/payouts",
      headers: { authorization },
    });
    expect(all.json().data).toHaveLength(2);
  });
});
