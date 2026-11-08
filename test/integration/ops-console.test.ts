import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/adapters/crypto/passwords.js";
import { insertOpsUser } from "../../src/adapters/db/ops.js";
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
const PASSWORD = "integration-ops-password";
const BENEFICIARY_IBAN = buildUaeIban("033", "1234567890123456");

let pool: Pool;
let app: FastifyInstance;
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
    opsSessionTtlHours: 12,
    version: "0.6.0-test",
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
  const tenant = await createTenant(pool, { code: "ops-test", legalName: "OPS TEST LLC" });
  tenantId = tenant.id;
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

async function seedUser(email: string, role: "viewer" | "operator" | "admin" = "operator") {
  return insertOpsUser(pool, {
    email,
    displayName: email.split("@")[0] ?? email,
    passwordHash: hashPassword(PASSWORD),
    role,
  });
}

async function login(email: string, password = PASSWORD, instance: FastifyInstance = app) {
  return instance.inject({
    method: "POST",
    url: "/ops/v1/auth/login",
    payload: { email, password },
  });
}

async function loginToken(email: string, role: "viewer" | "operator" | "admin" = "operator") {
  await seedUser(email, role);
  const response = await login(email);
  expect(response.statusCode).toBe(200);
  return response.json().token as string;
}

describe("ops login", () => {
  it("exchanges email + password for a session token", async () => {
    const user = await seedUser("operator@example.com", "operator");
    const response = await login("OPERATOR@example.com");

    expect(response.statusCode).toBe(200);
    expect(response.json().token).toMatch(/^ops_[0-9a-f]{8}_/);
    expect(response.json().user.email).toBe(user.email);
    expect(response.json().user.role).toBe("operator");
    expect(JSON.stringify(response.json())).not.toContain(PASSWORD);

    const me = await app.inject({
      method: "GET",
      url: "/ops/v1/auth/me",
      headers: { authorization: `Bearer ${response.json().token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.via).toBe("session");
    expect(me.json().user.email).toBe("operator@example.com");
  });

  it("rejects a wrong password and an unknown email identically", async () => {
    await seedUser("known@example.com");

    const wrong = await login("known@example.com", "not-the-password");
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.message).toBe("invalid email or password");

    const unknown = await login("nobody@example.com");
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error.message).toBe("invalid email or password");
  });

  it("revokes the session on logout", async () => {
    const token = await loginToken("logout@example.com");
    const authorization = `Bearer ${token}`;

    const out = await app.inject({
      method: "POST",
      url: "/ops/v1/auth/logout",
      headers: { authorization },
    });
    expect(out.statusCode).toBe(200);

    const me = await app.inject({
      method: "GET",
      url: "/ops/v1/auth/me",
      headers: { authorization },
    });
    expect(me.statusCode).toBe(401);
  });
});

describe("ops roles", () => {
  it("lets an operator write but refuses a viewer", async () => {
    const operatorToken = await loginToken("writer@example.com", "operator");
    const viewerToken = await loginToken("reader@example.com", "viewer");

    const written = await app.inject({
      method: "POST",
      url: `/ops/v1/accounts/${accountId}/simulate-credit`,
      headers: {
        authorization: `Bearer ${operatorToken}`,
        "idempotency-key": "ops-credit-1",
      },
      payload: { amount: "10.00" },
    });
    expect(written.statusCode).toBe(200);
    expect(written.json().balance.ledger).toBe("1010.00");

    const read = await app.inject({
      method: "GET",
      url: "/ops/v1/accounts",
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().data).toHaveLength(1);

    const refused = await app.inject({
      method: "POST",
      url: `/ops/v1/accounts/${accountId}/simulate-credit`,
      headers: { authorization: `Bearer ${viewerToken}`, "idempotency-key": "ops-credit-2" },
      payload: { amount: "10.00" },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("forbidden");
  });

  it("records the operator email as the audit actor", async () => {
    const token = await loginToken("audited@example.com", "operator");
    await app.inject({
      method: "POST",
      url: `/ops/v1/accounts/${accountId}/simulate-credit`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "ops-audit-1" },
      payload: { amount: "5.00" },
    });

    const actor = await pool.query<{ actor: string }>(
      "SELECT actor FROM audit_log WHERE action = 'transaction.credit_posted' ORDER BY id DESC LIMIT 1",
    );
    expect(actor.rows[0]?.actor).toBe("ops:audited@example.com");
  });
});

describe("ops auth in production shape", () => {
  it("keeps sessions working with dev ops disabled and the dev token dead", async () => {
    await seedUser("prod@example.com", "operator");
    const production = buildServer(makeEnv({ nodeEnv: "production", enableDevOps: false }));
    await production.ready();

    try {
      const devToken = await production.inject({
        method: "GET",
        url: "/ops/v1/clock",
        headers: { "x-ops-token": OPS_TOKEN },
      });
      expect(devToken.statusCode).toBe(401);

      const loggedIn = await login("prod@example.com", PASSWORD, production);
      expect(loggedIn.statusCode).toBe(200);

      const clock = await production.inject({
        method: "GET",
        url: "/ops/v1/clock",
        headers: { authorization: `Bearer ${loggedIn.json().token}` },
      });
      expect(clock.statusCode).toBe(200);
      expect(clock.json().mode).toBe("sim");
    } finally {
      await production.close();
    }
  });

  it("still accepts the dev token locally when ENABLE_DEV_OPS is true", async () => {
    const local = makeEnv();
    const response = await app.inject({
      method: "GET",
      url: "/ops/v1/clock",
      headers: { "x-ops-token": OPS_TOKEN },
    });
    expect(local.enableDevOps).toBe(true);
    expect(response.statusCode).toBe(200);
  });
});

describe("ops console", () => {
  it("serves the console page without a session", async () => {
    const response = await app.inject({ method: "GET", url: "/ops/console" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Ops sign in");
    expect(response.body).toContain("/ops/v1/auth/login");
  });

  it("redirects /ops to the console", async () => {
    const response = await app.inject({ method: "GET", url: "/ops" });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/ops/console");
  });

  it("lets the console arm and disarm a scenario across tenants", async () => {
    const key = await createApiKey(pool, { tenantId, pepper: PEPPER });
    const created = await app.inject({
      method: "POST",
      url: "/v1/payouts",
      headers: { authorization: `Bearer ${key.key}`, "idempotency-key": "console-payout-1" },
      payload: {
        account_id: accountId,
        amount: "100.00",
        beneficiary: { name: "GULF SUPPLIES LLC", iban: BENEFICIARY_IBAN },
      },
    });
    const payoutId = created.json().payout.id as string;

    const token = await loginToken("console@example.com", "operator");
    const armed = await app.inject({
      method: "POST",
      url: "/ops/v1/scenarios",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "console-arm-1" },
      payload: { payout_id: payoutId, kind: "sanctions_hold" },
    });
    expect(armed.statusCode).toBe(201);

    const disarmed = await app.inject({
      method: "DELETE",
      url: `/ops/v1/scenarios/${armed.json().scenario.id}`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "console-disarm-1" },
    });
    expect(disarmed.statusCode).toBe(200);
    expect(disarmed.json().scenario.status).toBe("disarmed");
  });

  it("requires a session for the ops reads", async () => {
    const response = await app.inject({ method: "GET", url: "/ops/v1/audit" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
  });
});
