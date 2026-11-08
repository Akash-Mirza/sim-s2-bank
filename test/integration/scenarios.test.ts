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
    version: "0.5.0-test",
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
  const tenant = await createTenant(pool, {
    code: "scenario-test",
    legalName: "SCENARIO TEST LLC",
  });
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

async function createPayout(key: string, amount = "250.00"): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/payouts",
    headers: { authorization, "idempotency-key": key },
    payload: {
      account_id: accountId,
      amount,
      reference: "INV-2026-0042",
      beneficiary: { name: "GULF SUPPLIES LLC", iban: BENEFICIARY_IBAN, bic: "EBILAEAD" },
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().payout.id as string;
}

async function advance(payoutId: string, key: string, to?: string) {
  return app.inject({
    method: "POST",
    url: `/ops/v1/payouts/${payoutId}/advance`,
    headers: { "x-ops-token": OPS_TOKEN, "idempotency-key": key },
    payload: to === undefined ? {} : { to },
  });
}

function arm(payoutId: string, key: string, kind: string, shortfall?: string) {
  return app.inject({
    method: "POST",
    url: "/v1/scenarios",
    headers: { authorization, "idempotency-key": key },
    payload: {
      payout_id: payoutId,
      kind,
      ...(shortfall === undefined ? {} : { shortfall }),
    },
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

function payoutDetail(payoutId: string) {
  return app.inject({
    method: "GET",
    url: `/v1/payouts/${payoutId}`,
    headers: { authorization },
  });
}

describe("underpaid", () => {
  it("settles for amount minus shortfall and leaves the difference available", async () => {
    const payoutId = await createPayout("sc-under-1");
    for (const [index, step] of ["validated", "submitted", "accepted"].entries()) {
      const moved = await advance(payoutId, `sc-under-adv-${index}`, step);
      expect(moved.statusCode, step).toBe(200);
    }

    const armed = await arm(payoutId, "sc-under-arm", "underpaid", "25.00");
    expect(armed.statusCode).toBe(201);
    expect(armed.json().scenario.kind).toBe("underpaid");
    expect(armed.json().scenario.shortfall).toBe("25.00");
    expect(armed.json().scenario.status).toBe("armed");

    const settled = await advance(payoutId, "sc-under-settle");
    expect(settled.statusCode).toBe(200);
    expect(settled.json().payout.status).toBe("settled");
    expect(settled.json().payout.settled_amount).toBe("225.00");
    expect(settled.json().payout.failure_code).toBe("underpaid");

    expect(await balance()).toEqual({
      available: "775.00",
      pending: "0.00",
      held: "0.00",
      ledger: "775.00",
    });

    const scenario = await pool.query<{ status: string; consumed_at: Date | null }>(
      "SELECT status, consumed_at FROM simulator_scenarios",
    );
    expect(scenario.rows[0]?.status).toBe("consumed");
    expect(scenario.rows[0]?.consumed_at).not.toBeNull();

    const holds = await pool.query<{ status: string }>("SELECT status FROM holds");
    expect(holds.rows[0]?.status).toBe("captured");

    const events = await pool.query<{ type: string; payload: { settled_amount: string } }>(
      "SELECT type, payload FROM outbox_events WHERE type = 'payout.settled'",
    );
    expect(events.rows[0]?.payload.settled_amount).toBe("225.00");
  });

  it("defaults the shortfall to ten percent and refuses a larger one", async () => {
    const payoutId = await createPayout("sc-under-2");
    const defaulted = await arm(payoutId, "sc-under-default", "underpaid");
    expect(defaulted.statusCode).toBe(201);
    expect(defaulted.json().scenario.shortfall).toBe("25.00");

    const tooBig = await arm(payoutId, "sc-under-too-big", "underpaid", "250.00");
    expect(tooBig.statusCode).toBe(400);
  });
});

describe("sanctions hold", () => {
  it("refuses accept with 423, stays armed, then advances after disarm", async () => {
    const payoutId = await createPayout("sc-sanction-1");
    for (const [index, step] of ["validated", "submitted"].entries()) {
      expect((await advance(payoutId, `sc-sanction-adv-${index}`, step)).statusCode).toBe(200);
    }

    const armed = await arm(payoutId, "sc-sanction-arm", "sanctions_hold");
    expect(armed.statusCode).toBe(201);
    const scenarioId = armed.json().scenario.id as string;

    const blocked = await advance(payoutId, "sc-sanction-block");
    expect(blocked.statusCode).toBe(423);
    expect(blocked.json().error.code).toBe("payment_held");

    const detail = await payoutDetail(payoutId);
    expect(detail.json().payout.status).toBe("submitted");
    expect((await balance()).held).toBe("250.00");

    const stillArmed = await app.inject({
      method: "GET",
      url: "/v1/scenarios?status=armed",
      headers: { authorization },
    });
    expect(stillArmed.json().data).toHaveLength(1);

    const disarmed = await app.inject({
      method: "DELETE",
      url: `/v1/scenarios/${scenarioId}`,
      headers: { authorization, "idempotency-key": "sc-sanction-disarm" },
    });
    expect(disarmed.statusCode).toBe(200);
    expect(disarmed.json().scenario.status).toBe("disarmed");

    const accepted = await advance(payoutId, "sc-sanction-accept");
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().payout.status).toBe("accepted");
  });
});

describe("bank timeout", () => {
  it("refuses accepted with 504, keeps the payout submitted, then succeeds on retry", async () => {
    const payoutId = await createPayout("sc-timeout-1");
    for (const [index, step] of ["validated", "submitted"].entries()) {
      expect((await advance(payoutId, `sc-timeout-adv-${index}`, step)).statusCode).toBe(200);
    }

    const armed = await arm(payoutId, "sc-timeout-arm", "bank_timeout");
    const scenarioId = armed.json().scenario.id as string;

    const timedOut = await advance(payoutId, "sc-timeout-fire");
    expect(timedOut.statusCode).toBe(504);
    expect(timedOut.json().error.code).toBe("rail_timeout");

    expect((await payoutDetail(payoutId)).json().payout.status).toBe("submitted");
    expect((await balance()).held).toBe("250.00");
    expect((await balance()).ledger).toBe("1000.00");

    await app.inject({
      method: "DELETE",
      url: `/v1/scenarios/${scenarioId}`,
      headers: { authorization, "idempotency-key": "sc-timeout-disarm" },
    });

    const retried = await advance(payoutId, "sc-timeout-retry");
    expect(retried.statusCode).toBe(200);
    expect(retried.json().payout.status).toBe("accepted");
  });
});

describe("returned", () => {
  it("redirects accept into returned and releases the reserve", async () => {
    const payoutId = await createPayout("sc-return-1");
    for (const [index, step] of ["validated", "submitted"].entries()) {
      expect((await advance(payoutId, `sc-return-adv-${index}`, step)).statusCode).toBe(200);
    }

    expect((await arm(payoutId, "sc-return-arm", "returned")).statusCode).toBe(201);

    const returned = await advance(payoutId, "sc-return-fire");
    expect(returned.statusCode).toBe(200);
    expect(returned.json().payout.status).toBe("returned");

    expect(await balance()).toEqual({
      available: "1000.00",
      pending: "0.00",
      held: "0.00",
      ledger: "1000.00",
    });

    const holds = await pool.query<{ status: string }>("SELECT status FROM holds");
    expect(holds.rows[0]?.status).toBe("released");

    const transactions = await pool.query("SELECT count(*)::int AS count FROM transactions");
    expect(transactions.rows[0]?.count).toBe(1);
  });
});

describe("scenario guard rails", () => {
  it("arms at most one scenario per payout", async () => {
    const payoutId = await createPayout("sc-guard-1");
    expect((await arm(payoutId, "sc-guard-arm-1", "sanctions_hold")).statusCode).toBe(201);

    const second = await arm(payoutId, "sc-guard-arm-2", "bank_timeout");
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("scenario_conflict");
  });

  it("refuses a scenario on a terminal payout", async () => {
    const payoutId = await createPayout("sc-guard-2");
    await app.inject({
      method: "POST",
      url: `/v1/payouts/${payoutId}/cancel`,
      headers: { authorization, "idempotency-key": "sc-guard-cancel" },
      payload: {},
    });

    const response = await arm(payoutId, "sc-guard-terminal", "underpaid");
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/already cancelled/);
  });

  it("rejects a shortfall on a scenario that has no shortfall", async () => {
    const payoutId = await createPayout("sc-guard-3");
    const response = await arm(payoutId, "sc-guard-shortfall", "bank_timeout", "5.00");
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/only applies to underpaid/);
  });

  it("keeps scenarios tenant-scoped", async () => {
    const payoutId = await createPayout("sc-guard-4");
    await arm(payoutId, "sc-guard-arm-scope", "sanctions_hold");

    const otherTenant = await createTenant(pool, {
      code: "other-scenario-tenant",
      legalName: "OTHER LLC",
    });
    const otherKey = await createApiKey(pool, { tenantId: otherTenant.id, pepper: PEPPER });

    const listed = await app.inject({
      method: "GET",
      url: "/v1/scenarios",
      headers: { authorization: `Bearer ${otherKey.key}` },
    });
    expect(listed.json().data).toHaveLength(0);

    const armed = await app.inject({
      method: "POST",
      url: "/v1/scenarios",
      headers: {
        authorization: `Bearer ${otherKey.key}`,
        "idempotency-key": "sc-guard-other-arm",
      },
      payload: { payout_id: payoutId, kind: "underpaid" },
    });
    expect(armed.statusCode).toBe(404);
  });
});
