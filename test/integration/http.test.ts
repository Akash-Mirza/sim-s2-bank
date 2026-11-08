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
let tenantId: string;

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
  const tenant = await createTenant(pool, { code: "api-test", legalName: "API TEST LLC" });
  tenantId = tenant.id;
  const key = await createApiKey(pool, { tenantId, pepper: PEPPER });
  authorization = `Bearer ${key.key}`;
});

describe("http surface", () => {
  it("serves health, readiness, version, and metadata", async () => {
    for (const url of ["/health", "/ready", "/version", "/v1/meta"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(200);
      expect(response.json().mode).toBe("sim");
    }
    const version = await app.inject({ method: "GET", url: "/version" });
    expect(version.json().schema_version).toBe("0005_outbox_webhooks.sql");
    expect(version.headers["x-request-id"]).toBeTruthy();
  });

  it("requires a bearer key on tenant routes", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/accounts" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
  });

  it("creates an account with a valid UAE IBAN and zero balance", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: { authorization, "idempotency-key": "create-1" },
      payload: { product_code: "corporate_current" },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.account.iban).toMatch(/^AE\d{21}$/);
    expect(body.account.bic).toBe("SIMSAEXXXX");
    expect(body.balance.ledger).toBe("0.00");

    const balance = await app.inject({
      method: "GET",
      url: `/v1/accounts/${body.account.id}/balance`,
      headers: { authorization },
    });
    expect(balance.statusCode).toBe(200);
    expect(balance.json().balance.available).toBe("0.00");
  });

  it("injects a credit through the guarded dev ops endpoint and lists it", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: { authorization, "idempotency-key": "acct-ops-test" },
      payload: {},
    });
    const accountId = created.json().account.id;

    const rejected = await app.inject({
      method: "POST",
      url: `/ops/v1/accounts/${accountId}/simulate-credit`,
      payload: { amount: "1250.00" },
    });
    expect(rejected.statusCode).toBe(401);

    const posted = await app.inject({
      method: "POST",
      url: `/ops/v1/accounts/${accountId}/simulate-credit`,
      headers: { "x-ops-token": OPS_TOKEN, "idempotency-key": "ops-credit-1" },
      payload: { amount: "1250.00", reference: "DEP-2026-000123" },
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json().balance.available).toBe("1250.00");
    expect(posted.json().balance.ledger).toBe("1250.00");

    const list = await app.inject({
      method: "GET",
      url: `/v1/accounts/${accountId}/transactions?limit=10`,
      headers: { authorization },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0].reference).toBe("DEP-2026-000123");
    expect(list.json().next_cursor).toBeNull();
  });

  it("rejects malformed amounts and unknown accounts with mapped errors", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: { authorization, "idempotency-key": "acct-bad-amount" },
      payload: {},
    });
    const accountId = created.json().account.id;

    const badAmount = await app.inject({
      method: "POST",
      url: `/ops/v1/accounts/${accountId}/simulate-credit`,
      headers: { "x-ops-token": OPS_TOKEN, "idempotency-key": "ops-bad-amount" },
      payload: { amount: "12.345" },
    });
    expect(badAmount.statusCode).toBe(400);
    expect(badAmount.json().error.code).toBe("validation_error");

    const missing = await app.inject({
      method: "GET",
      url: "/v1/accounts/00000000-0000-4000-8000-000000000000",
      headers: { authorization },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("not_found");
  });

  it("hides ops routes when dev endpoints are disabled", async () => {
    const env: Env = {
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 0,
      databaseUrl: testDatabaseUrl(),
      logLevel: "silent",
      simClock: undefined,
      enableDevOps: false,
      opsDevToken: OPS_TOKEN,
      apiKeyPepper: PEPPER,
      version: "0.1.0-test",
      gitCommit: "test",
    };
    const hardened = buildServer(env);
    await hardened.ready();
    try {
      const response = await hardened.inject({
        method: "POST",
        url: "/ops/v1/accounts/00000000-0000-4000-8000-000000000000/simulate-credit",
        headers: { "x-ops-token": OPS_TOKEN },
        payload: { amount: "1.00" },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await hardened.close();
    }
  });
});
