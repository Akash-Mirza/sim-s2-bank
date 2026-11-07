import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApiKey, createTenant } from "../../src/adapters/db/tenants.js";
import { createAccount } from "../../src/application/create-account.js";
import { businessDate } from "../../src/config/clock.js";
import type { Env } from "../../src/config/env.js";
import { buildUaeIban } from "../../src/domain/iban.js";
import { buildServer } from "../../src/http/server.js";
import { connectTestDatabase, testDatabaseUrl, truncateAll } from "./helpers.js";

const PEPPER = "integration-test-pepper-0123456789";
const OPS_TOKEN = "integration-ops-token";
const BENEFICIARY_IBAN = buildUaeIban("033", "1234567890123456");
const INITIAL_CLOCK = "2026-11-05T08:00:00.000Z"; // Thursday 12:00 Asia/Dubai

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
    simClock: INITIAL_CLOCK,
    enableDevOps: true,
    opsDevToken: OPS_TOKEN,
    apiKeyPepper: PEPPER,
    version: "0.3.0-test",
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
  await app.inject({
    method: "POST",
    url: "/ops/v1/clock/freeze",
    headers: { "x-ops-token": OPS_TOKEN },
    payload: { at: INITIAL_CLOCK },
  });

  const tenant = await createTenant(pool, { code: "stmt-test", legalName: "STATEMENT TEST LLC" });
  tenantId = tenant.id;
  const key = await createApiKey(pool, { tenantId, pepper: PEPPER });
  authorization = `Bearer ${key.key}`;
  const account = await createAccount(pool, { tenantId, actor: "test" });
  accountId = account.id;
});

async function credit(amount: string, reference: string, key: string): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: `/ops/v1/accounts/${accountId}/simulate-credit`,
    headers: { "x-ops-token": OPS_TOKEN, "idempotency-key": key },
    payload: { amount, reference },
  });
  expect(response.statusCode).toBe(200);
}

async function settlePayout(amount: string, reference: string): Promise<void> {
  const created = await app.inject({
    method: "POST",
    url: "/v1/payouts",
    headers: { authorization, "idempotency-key": `pay-${reference}` },
    payload: {
      account_id: accountId,
      amount,
      reference,
      beneficiary: { name: "GULF SUPPLIES LLC", iban: BENEFICIARY_IBAN, bic: "EBILAEAD" },
    },
  });
  expect(created.statusCode).toBe(201);
  const payoutId = created.json().payout.id as string;

  for (let step = 0; step < 4; step += 1) {
    const advanced = await app.inject({
      method: "POST",
      url: `/ops/v1/payouts/${payoutId}/advance`,
      headers: { "x-ops-token": OPS_TOKEN, "idempotency-key": `adv-${reference}-${step}` },
      payload: {},
    });
    expect(advanced.statusCode).toBe(200);
  }
  expect(
    (
      await app.inject({
        method: "GET",
        url: `/v1/payouts/${payoutId}`,
        headers: { authorization },
      })
    ).json().payout.status,
  ).toBe("settled");
}

async function stepClock(payload: Record<string, number>): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/ops/v1/clock/step",
    headers: { "x-ops-token": OPS_TOKEN },
    payload,
  });
  expect(response.statusCode).toBe(200);
}

async function closeEod(
  body: Record<string, unknown>,
  key: string,
): Promise<Awaited<ReturnType<FastifyInstance["inject"]>>> {
  return app.inject({
    method: "POST",
    url: `/v1/accounts/${accountId}/eod/close`,
    headers: { authorization, "idempotency-key": key },
    payload: body,
  });
}

function mt940Balance(mt940: string, tag: "60F" | "62F"): number {
  const match = new RegExp(`:${tag}:[CD]\\d{6}AED([\\d,]+)`).exec(mt940);
  expect(match).not.toBeNull();
  return Number((match?.[1] ?? "0").replace(",", "."));
}

describe("statements and EOD", () => {
  it("renders JSON, CSV and MT940 from the same ledger and they agree", async () => {
    await credit("1000.00", "DEP-001", "credit-1");
    await credit("250.00", "DEP-002", "credit-2");
    await settlePayout("400.00", "INV-001");

    const jsonResponse = await app.inject({
      method: "GET",
      url: `/v1/accounts/${accountId}/statement?from=2026-11-05&to=2026-11-05&format=json`,
      headers: { authorization },
    });
    expect(jsonResponse.statusCode).toBe(200);
    const json = jsonResponse.json();
    expect(json.mode).toBe("sim");
    expect(json.opening_balance).toBe("0.00");
    expect(json.closing_balance).toBe("850.00");
    expect(json.totals).toEqual({ credits: "1250.00", debits: "400.00", count: 3 });
    expect(json.lines).toHaveLength(3);

    const csvResponse = await app.inject({
      method: "GET",
      url: `/v1/accounts/${accountId}/statements/2026-11-05/csv`,
      headers: { authorization },
    });
    expect(csvResponse.statusCode).toBe(200);
    expect(csvResponse.headers["content-type"]).toContain("text/csv");
    const csvLines = csvResponse.body.trim().split("\n");
    expect(csvLines).toHaveLength(4);
    const csvCredits = csvLines
      .slice(1)
      .filter((row) => row.split(",")[4] === "credit")
      .reduce((total, row) => total + Number(row.split(",")[2]), 0);
    const csvDebits = csvLines
      .slice(1)
      .filter((row) => row.split(",")[4] === "debit")
      .reduce((total, row) => total + Number(row.split(",")[2]), 0);
    expect(csvCredits).toBe(1250);
    expect(csvDebits).toBe(400);

    const mtResponse = await app.inject({
      method: "GET",
      url: `/v1/accounts/${accountId}/statements/2026-11-05/mt940`,
      headers: { authorization },
    });
    expect(mtResponse.statusCode).toBe(200);
    expect(mtResponse.headers["content-type"]).toContain("text/plain");
    expect(mtResponse.body).toContain(":25:");
    expect(mtResponse.body.match(/:61:/g)).toHaveLength(3);
    expect(mt940Balance(mtResponse.body, "60F")).toBe(0);
    expect(mt940Balance(mtResponse.body, "62F")).toBe(850);
  });

  it("carries opening and closing balances across a date range", async () => {
    await credit("1000.00", "DEP-001", "credit-1");
    await stepClock({ days: 1 });
    await credit("100.00", "DEP-002", "credit-2");

    const range = await app.inject({
      method: "GET",
      url: `/v1/accounts/${accountId}/statement?from=2026-11-05&to=2026-11-06`,
      headers: { authorization },
    });
    expect(range.statusCode).toBe(200);
    expect(range.json().opening_balance).toBe("0.00");
    expect(range.json().closing_balance).toBe("1100.00");
    expect(range.json().lines).toHaveLength(2);

    const secondDay = await app.inject({
      method: "GET",
      url: `/v1/accounts/${accountId}/statement?from=2026-11-06&to=2026-11-06`,
      headers: { authorization },
    });
    expect(secondDay.json().opening_balance).toBe("1000.00");
    expect(secondDay.json().closing_balance).toBe("1100.00");
  });

  it("isolates tenants and validates the range", async () => {
    const other = await createTenant(pool, { code: "other", legalName: "OTHER LLC" });
    const otherAccount = await createAccount(pool, { tenantId: other.id, actor: "test" });

    const crossTenant = await app.inject({
      method: "GET",
      url: `/v1/accounts/${otherAccount.id}/statement`,
      headers: { authorization },
    });
    expect(crossTenant.statusCode).toBe(404);

    const reversed = await app.inject({
      method: "GET",
      url: `/v1/accounts/${accountId}/statement?from=2026-11-06&to=2026-11-05`,
      headers: { authorization },
    });
    expect(reversed.statusCode).toBe(400);

    const tooLong = await app.inject({
      method: "GET",
      url: `/v1/accounts/${accountId}/statement?from=2025-01-01&to=2026-11-05`,
      headers: { authorization },
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error.code).toBe("validation_error");
  });

  it("closes EOD once, sequentially, and replays idempotently", async () => {
    await credit("1000.00", "DEP-001", "credit-1");

    const first = await closeEod({ business_date: "2026-11-05" }, "eod-1");
    expect(first.statusCode).toBe(201);
    expect(first.json().eod).toMatchObject({
      business_date: "2026-11-05",
      status: "closed",
      opening_balance: "0.00",
      closing_balance: "1000.00",
      credits: "1000.00",
      debits: "0.00",
      line_count: 1,
      closed_by: expect.stringMatching(/^api_key:/),
    });
    expect(first.json().last_closed_business_date).toBe("2026-11-05");

    const replay = await closeEod({ business_date: "2026-11-05" }, "eod-1");
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");

    const duplicate = await closeEod({ business_date: "2026-11-05" }, "eod-2");
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("invalid_state_transition");

    const future = await closeEod({ business_date: "2026-11-06" }, "eod-3");
    expect(future.statusCode).toBe(400);

    await stepClock({ days: 4 });
    expect(businessDate(new Date(INITIAL_CLOCK))).toBe("2026-11-05");

    const skipped = await closeEod({ business_date: "2026-11-09" }, "eod-4");
    expect(skipped.statusCode).toBe(409);
    expect(skipped.json().error.details.allowed).toEqual(["2026-11-06"]);

    const next = await closeEod({ business_date: "2026-11-06" }, "eod-5");
    expect(next.statusCode).toBe(201);

    const monday = await closeEod({ business_date: "2026-11-09" }, "eod-6");
    expect(monday.statusCode).toBe(201);

    const summary = await app.inject({
      method: "GET",
      url: `/v1/accounts/${accountId}/eod`,
      headers: { authorization },
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().last_closed_business_date).toBe("2026-11-09");
    expect(summary.json().data).toHaveLength(3);
    expect(summary.json().data[0].business_date).toBe("2026-11-09");

    const one = await app.inject({
      method: "GET",
      url: `/v1/accounts/${accountId}/eod/2026-11-05`,
      headers: { authorization },
    });
    expect(one.statusCode).toBe(200);
    expect(one.json().eod.closing_balance).toBe("1000.00");

    const statement = await app.inject({
      method: "GET",
      url: `/v1/accounts/${accountId}/statement?from=2026-11-05&to=2026-11-05`,
      headers: { authorization },
    });
    expect(statement.json().closing_balance).toBe(one.json().eod.closing_balance);
  });

  it("uses the adjustable ops clock for the default EOD date", async () => {
    await credit("10.00", "DEP-001", "credit-1");

    const today = await closeEod({}, "eod-today");
    expect(today.statusCode).toBe(201);
    expect(today.json().eod.business_date).toBe("2026-11-05");

    const clock = await app.inject({
      method: "GET",
      url: "/ops/v1/clock",
      headers: { "x-ops-token": OPS_TOKEN },
    });
    expect(clock.statusCode).toBe(200);
    expect(clock.json().clock.frozen).toBe(true);

    await stepClock({ days: 1 });
    const next = await closeEod({}, "eod-next");
    expect(next.statusCode).toBe(201);
    expect(next.json().eod.business_date).toBe("2026-11-06");

    const freezeWeekend = await app.inject({
      method: "POST",
      url: "/ops/v1/clock/freeze",
      headers: { "x-ops-token": OPS_TOKEN },
      payload: { at: "2026-11-07T08:00:00.000Z" },
    });
    expect(freezeWeekend.statusCode).toBe(200);
    expect(freezeWeekend.json().clock.now).toBe("2026-11-07T08:00:00.000Z");

    const weekend = await closeEod({}, "eod-weekend");
    expect(weekend.statusCode).toBe(400);
    expect(weekend.json().error.message).toMatch(/UAE business day/);
  });

  it("refuses the EOD write without a scope or an idempotency key", async () => {
    const readOnlyKey = await createApiKey(pool, {
      tenantId,
      pepper: PEPPER,
      scopes: ["accounts:read"],
    });

    const noScope = await app.inject({
      method: "POST",
      url: `/v1/accounts/${accountId}/eod/close`,
      headers: {
        authorization: `Bearer ${readOnlyKey.key}`,
        "idempotency-key": "eod-noscope",
      },
      payload: {},
    });
    expect(noScope.statusCode).toBe(403);

    const noKey = await app.inject({
      method: "POST",
      url: `/v1/accounts/${accountId}/eod/close`,
      headers: { authorization },
      payload: {},
    });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().error.message).toMatch(/Idempotency-Key/);
  });
});
