import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createApiKey,
  createTenant,
  listApiKeys,
  revokeApiKey,
} from "../../src/adapters/db/tenants.js";
import type { Env } from "../../src/config/env.js";
import { buildServer } from "../../src/http/server.js";
import { connectTestDatabase, testDatabaseUrl, truncateAll } from "./helpers.js";

const PEPPER = "integration-test-pepper-0123456789";
const OPS_TOKEN = "integration-ops-token";

let pool: Pool;
let app: FastifyInstance;
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
    version: "1.0.0-test",
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
  const tenant = await createTenant(pool, { code: "key-test", legalName: "KEY TEST LLC" });
  tenantId = tenant.id;
});

describe("tenant api key lifecycle", () => {
  it("issues a key that authenticates, lists without its secret, then revokes", async () => {
    const issued = await createApiKey(pool, { tenantId, pepper: PEPPER });

    const authorized = await app.inject({
      method: "GET",
      url: "/v1/accounts",
      headers: { authorization: `Bearer ${issued.key}` },
    });
    expect(authorized.statusCode).toBe(200);

    const listed = await listApiKeys(pool, "key-test");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      tenantCode: "key-test",
      prefix: issued.prefix,
      status: "active",
    });
    // Metadata only: neither the plaintext key nor its hash is exposed.
    expect(JSON.stringify(listed)).not.toContain(issued.key);
    expect(Object.keys(listed[0] ?? {})).not.toContain("secretHash");

    const revoked = await revokeApiKey(pool, issued.prefix);
    expect(revoked?.status).toBe("revoked");

    const rejected = await app.inject({
      method: "GET",
      url: "/v1/accounts",
      headers: { authorization: `Bearer ${issued.key}` },
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json().error.code).toBe("unauthorized");
  });

  it("scopes a key down to the scopes it was issued with", async () => {
    const issued = await createApiKey(pool, {
      tenantId,
      pepper: PEPPER,
      scopes: ["accounts:read"],
    });

    const allowed = await app.inject({
      method: "GET",
      url: "/v1/accounts",
      headers: { authorization: `Bearer ${issued.key}` },
    });
    expect(allowed.statusCode).toBe(200);

    const forbidden = await app.inject({
      method: "POST",
      url: "/v1/payouts",
      headers: {
        authorization: `Bearer ${issued.key}`,
        "idempotency-key": "scoped-payout",
      },
      payload: { account_id: "00000000-0000-4000-8000-000000000000", amount: "1.00" },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("returns null when revoking a prefix that does not exist", async () => {
    expect(await revokeApiKey(pool, "s2k_missing0000")).toBeNull();
    expect(await listApiKeys(pool, "key-test")).toHaveLength(0);
  });
});
