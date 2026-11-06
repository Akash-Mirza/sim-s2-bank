import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApiKey, createTenant } from "../../src/adapters/db/tenants.js";
import type { Env } from "../../src/config/env.js";
import { buildServer } from "../../src/http/server.js";
import { connectTestDatabase, testDatabaseUrl, truncateAll } from "./helpers.js";

const PEPPER = "integration-test-pepper-0123456789";
const OPS_TOKEN = "integration-ops-token";

let pool: Pool;
let app: FastifyInstance;
let authorization: string;

beforeAll(async () => {
  pool = await connectTestDatabase();
  const env: Env = {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    databaseUrl: testDatabaseUrl(),
    logLevel: "silent",
    simClock: undefined,
    enableDevOps: true,
    opsDevToken: OPS_TOKEN,
    apiKeyPepper: PEPPER,
    version: "0.1.0-test",
    gitCommit: "test",
  };
  app = buildServer(env);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
  const tenant = await createTenant(pool, { code: "idem-test", legalName: "IDEM TEST LLC" });
  const key = await createApiKey(pool, { tenantId: tenant.id, pepper: PEPPER });
  authorization = `Bearer ${key.key}`;
});

async function createAccount(): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/accounts",
    headers: { authorization, "idempotency-key": `acct-${Math.random()}` },
    payload: {},
  });
  expect(response.statusCode).toBe(201);
  return response.json().account.id;
}

function credit(accountId: string, key: string, amount = "10.00") {
  return app.inject({
    method: "POST",
    url: `/v1/accounts/${accountId}/credits:simulate`,
    headers: { authorization, "idempotency-key": key },
    payload: { amount, reference: "DEP-1" },
  });
}

describe("idempotent writes", () => {
  it("replays the stored response and posts only once", async () => {
    const accountId = await createAccount();

    const first = await credit(accountId, "dep-1");
    expect(first.statusCode).toBe(200);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();

    const second = await credit(accountId, "dep-1");
    expect(second.statusCode).toBe(200);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.json()).toEqual(first.json());
    expect(second.json().transaction.id).toBe(first.json().transaction.id);
    expect(second.json().balance.available).toBe("10.00");

    const transactions = await pool.query("SELECT count(*)::int AS count FROM transactions");
    expect(transactions.rows[0]?.count).toBe(1);
    const entries = await pool.query("SELECT count(*)::int AS count FROM ledger_entries");
    expect(entries.rows[0]?.count).toBe(2);
    const keys = await pool.query("SELECT count(*)::int AS count FROM idempotency_keys");
    expect(keys.rows[0]?.count).toBe(2);
  });

  it("rejects the same key with a different body and changes nothing", async () => {
    const accountId = await createAccount();
    await credit(accountId, "dep-1", "10.00");

    const conflict = await credit(accountId, "dep-1", "11.00");
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("idempotency_conflict");

    const balance = await app.inject({
      method: "GET",
      url: `/v1/accounts/${accountId}/balance`,
      headers: { authorization },
    });
    expect(balance.json().balance.available).toBe("10.00");
  });

  it("requires the key on tenant and ops writes", async () => {
    const accountId = await createAccount();

    const tenantWrite = await app.inject({
      method: "POST",
      url: `/v1/accounts/${accountId}/credits:simulate`,
      headers: { authorization },
      payload: { amount: "1.00" },
    });
    expect(tenantWrite.statusCode).toBe(400);
    expect(tenantWrite.json().error.code).toBe("validation_error");

    const opsWrite = await app.inject({
      method: "POST",
      url: `/ops/v1/accounts/${accountId}/simulate-credit`,
      headers: { "x-ops-token": OPS_TOKEN },
      payload: { amount: "1.00" },
    });
    expect(opsWrite.statusCode).toBe(400);

    const accountWrite = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: { authorization },
      payload: {},
    });
    expect(accountWrite.statusCode).toBe(400);
  });

  it("does not cache a failed attempt", async () => {
    const accountId = await createAccount();
    await pool.query("UPDATE accounts SET status = 'restricted' WHERE id = $1", [accountId]);

    const refused = await credit(accountId, "dep-retry");
    expect(refused.statusCode).toBe(423);
    expect(refused.json().error.code).toBe("account_restricted");

    await pool.query("UPDATE accounts SET status = 'open' WHERE id = $1", [accountId]);
    const accepted = await credit(accountId, "dep-retry");
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().balance.available).toBe("10.00");
  });

  it("posts exactly once when identical requests race", async () => {
    const accountId = await createAccount();

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => credit(accountId, "dep-race")),
    );
    for (const response of responses) expect(response.statusCode).toBe(200);

    const ids = new Set(responses.map((response) => response.json().transaction.id));
    expect(ids.size).toBe(1);

    const transactions = await pool.query("SELECT count(*)::int AS count FROM transactions");
    expect(transactions.rows[0]?.count).toBe(1);
    const balance = await app.inject({
      method: "GET",
      url: `/v1/accounts/${accountId}/balance`,
      headers: { authorization },
    });
    expect(balance.json().balance.available).toBe("10.00");
  });

  it("replays an account creation instead of opening a second IBAN", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: { authorization, "idempotency-key": "acct-fixed" },
      payload: { product_code: "corporate_current" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: { authorization, "idempotency-key": "acct-fixed" },
      payload: { product_code: "corporate_current" },
    });

    expect(second.statusCode).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.json().account.id).toBe(first.json().account.id);

    const accounts = await pool.query("SELECT count(*)::int AS count FROM accounts");
    expect(accounts.rows[0]?.count).toBe(1);
  });
});
