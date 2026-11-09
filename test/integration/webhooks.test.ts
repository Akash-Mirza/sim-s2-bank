import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "../../src/adapters/crypto/webhooks.js";
import { createApiKey, createTenant } from "../../src/adapters/db/tenants.js";
import { createAccount } from "../../src/application/create-account.js";
import type { Env } from "../../src/config/env.js";
import { buildServer } from "../../src/http/server.js";
import { connectTestDatabase, testDatabaseUrl, truncateAll } from "./helpers.js";

const PEPPER = "integration-test-pepper-0123456789";
const OPS_TOKEN = "integration-ops-token";
const WEBHOOK_KEY = "integration-webhook-secret-key-0123456789";

interface Captured {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let pool: Pool;
let app: FastifyInstance;
let receiver: Server;
let receiverUrl: string;
let authorization: string;
let tenantId: string;
let accountId: string;

let requests: Captured[] = [];
let responder: (attempt: number) => number = () => 200;

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
    webhookSecretKey: WEBHOOK_KEY,
    version: "0.4.0-test",
    gitCommit: "test",
    ...overrides,
  };
}

beforeAll(async () => {
  pool = await connectTestDatabase();

  receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push({ headers: req.headers, body });
      res.statusCode = responder(requests.length);
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const address = receiver.address() as AddressInfo;
  receiverUrl = `http://127.0.0.1:${address.port}`;

  app = buildServer(makeEnv());
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await new Promise<void>((resolve, reject) =>
    receiver.close((error) => (error === undefined ? resolve() : reject(error))),
  );
});

beforeEach(async () => {
  await truncateAll(pool);
  requests = [];
  responder = () => 200;

  const tenant = await createTenant(pool, { code: "wh-test", legalName: "WEBHOOK TEST LLC" });
  tenantId = tenant.id;
  const key = await createApiKey(pool, { tenantId, pepper: PEPPER });
  authorization = `Bearer ${key.key}`;
  const account = await createAccount(pool, { tenantId, actor: "test" });
  accountId = account.id;
});

async function createSubscription(
  events: string[],
  key: string,
): Promise<{ id: string; secret: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/webhooks",
    headers: { authorization, "idempotency-key": key },
    payload: { url: `${receiverUrl}/hook`, events },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json();
  expect(body.secret.startsWith("whsec_")).toBe(true);
  return { id: body.subscription.id as string, secret: body.secret as string };
}

async function credit(amount: string, reference: string, key: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/ops/v1/accounts/${accountId}/simulate-credit`,
    headers: { "x-ops-token": OPS_TOKEN, "idempotency-key": key },
    payload: { amount, reference },
  });
  expect(response.statusCode).toBe(200);
  return response.json().transaction.id as string;
}

async function dispatch(): Promise<Record<string, number>> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/outbox/dispatch",
    headers: { authorization },
    payload: {},
  });
  expect(response.statusCode).toBe(200);
  return response.json().dispatch;
}

async function deliveries(subscriptionId: string) {
  const response = await app.inject({
    method: "GET",
    url: `/v1/webhooks/${subscriptionId}/deliveries`,
    headers: { authorization },
  });
  expect(response.statusCode).toBe(200);
  return response.json().data as Array<Record<string, unknown>>;
}

async function makeDue(deliveryId?: string): Promise<void> {
  if (deliveryId === undefined) {
    await pool.query("UPDATE webhook_deliveries SET next_retry_at = now() - interval '1 second'");
    return;
  }
  await pool.query(
    "UPDATE webhook_deliveries SET next_retry_at = now() - interval '1 second' WHERE id = $1",
    [deliveryId],
  );
}

describe("outbox and signed webhooks", () => {
  it("delivers a credit event with a valid signature and a delivered receipt", async () => {
    const subscription = await createSubscription(["credit.posted"], "sub-1");
    const transactionId = await credit("250.00", "DEP-WH-1", "credit-1");

    const summary = await dispatch();
    expect(summary).toMatchObject({ claimed: 1, delivered: 1, failed: 0, dead: 0 });
    expect(requests).toHaveLength(1);

    const received = requests[0];
    expect(received).toBeDefined();
    expect(received?.headers["x-sim-event"]).toBe("credit.posted");
    expect(received?.headers["x-sim-attempt"]).toBe("1");

    const body = JSON.parse(received?.body ?? "{}");
    expect(body).toMatchObject({
      type: "credit.posted",
      data: {
        transaction_id: transactionId,
        account_id: accountId,
        amount: "250.00",
        currency: "AED",
        reference: "DEP-WH-1",
        direction: "credit",
      },
    });

    const header = received?.headers["x-sim-signature"];
    expect(typeof header).toBe("string");
    const verified = verifyWebhookSignature({
      secret: subscription.secret,
      header: typeof header === "string" ? header : undefined,
      body: received?.body ?? "",
    });
    expect(verified).toEqual({ valid: true });

    const recorded = await deliveries(subscription.id);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      status: "delivered",
      attempts: 1,
      last_status_code: 200,
      last_error: null,
      event_id: body.id,
    });
    expect(recorded[0]?.signature).toBe(header);

    const pulled = await app.inject({
      method: "GET",
      url: "/v1/events?after=0",
      headers: { authorization },
    });
    expect(pulled.statusCode).toBe(200);
    expect(pulled.json().data).toHaveLength(1);
    expect(pulled.json().data[0]).toMatchObject({
      type: "credit.posted",
      account_id: accountId,
      data: { transaction_id: transactionId },
    });
  });

  it("retries a failed attempt with backoff, then delivers", async () => {
    const subscription = await createSubscription(["credit.posted"], "sub-retry");
    await credit("10.00", "DEP-WH-2", "credit-1");

    responder = (attempt) => (attempt === 1 ? 500 : 200);

    const dispatchedAt = Date.now();
    const first = await dispatch();
    expect(first).toMatchObject({ claimed: 1, delivered: 0, failed: 1, dead: 0 });
    expect(requests).toHaveLength(1);

    const afterFirst = await deliveries(subscription.id);
    expect(afterFirst[0]).toMatchObject({
      status: "failed",
      attempts: 1,
      last_status_code: 500,
    });
    expect(afterFirst[0]?.last_error).toMatch(/receiver returned 500/);
    // The retry must be scheduled after the dispatch started. Comparing with
    // Date.now() *here* races the database round-trip (a remote database can
    // take longer than the fixed backoff), so compare with the dispatch start.
    expect(Date.parse(String(afterFirst[0]?.next_retry_at))).toBeGreaterThan(dispatchedAt);

    // Not due yet: a second tick must not send again.
    const tooSoon = await dispatch();
    expect(tooSoon.claimed).toBe(0);
    expect(requests).toHaveLength(1);

    await makeDue();
    const second = await dispatch();
    expect(second).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.headers["x-sim-attempt"])).toEqual(["1", "2"]);

    const afterSecond = await deliveries(subscription.id);
    expect(afterSecond[0]).toMatchObject({
      status: "delivered",
      attempts: 2,
      last_status_code: 200,
    });
  });

  it("dead-letters after max attempts and replays an operator retry", async () => {
    const subscription = await createSubscription(["credit.posted"], "sub-dead");
    await credit("5.00", "DEP-WH-3", "credit-1");

    responder = () => 503;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await makeDue();
      const summary = await dispatch();
      expect(summary.claimed).toBe(1);
      if (attempt < 5) expect(summary.failed).toBe(1);
      else expect(summary.dead).toBe(1);
    }
    expect(requests).toHaveLength(5);

    const dead = await deliveries(subscription.id);
    expect(dead[0]).toMatchObject({
      status: "dead",
      attempts: 5,
      max_attempts: 5,
      last_status_code: 503,
    });

    responder = () => 200;
    const replay = await app.inject({
      method: "POST",
      url: `/ops/v1/webhooks/deliveries/${String(dead[0]?.id)}/replay`,
      headers: { "x-ops-token": OPS_TOKEN, "idempotency-key": "replay-1" },
      payload: {},
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().delivery).toMatchObject({ status: "pending", attempts: 0 });

    const replayed = await dispatch();
    expect(replayed).toMatchObject({ claimed: 1, delivered: 1 });

    const recovered = await deliveries(subscription.id);
    expect(recovered[0]).toMatchObject({ status: "delivered", attempts: 1 });
  });

  it("isolates tenants and refuses URL or filter mistakes", async () => {
    const subscription = await createSubscription(["payout.*"], "sub-iso");
    await credit("1.00", "DEP-WH-4", "credit-1");
    await dispatch();

    const other = await createTenant(pool, { code: "wh-other", legalName: "OTHER LLC" });
    const otherKey = await createApiKey(pool, { tenantId: other.id, pepper: PEPPER });
    const otherAuthorization = `Bearer ${otherKey.key}`;

    const list = await app.inject({
      method: "GET",
      url: "/v1/webhooks",
      headers: { authorization: otherAuthorization },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toEqual([]);

    const crossTenant = await app.inject({
      method: "GET",
      url: `/v1/webhooks/${subscription.id}/deliveries`,
      headers: { authorization: otherAuthorization },
    });
    expect(crossTenant.statusCode).toBe(404);

    const otherEvents = await app.inject({
      method: "GET",
      url: "/v1/events",
      headers: { authorization: otherAuthorization },
    });
    expect(otherEvents.json().data).toEqual([]);

    const badUrl = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { authorization, "idempotency-key": "bad-url" },
      payload: { url: "ftp://example.com/hook", events: ["credit.posted"] },
    });
    expect(badUrl.statusCode).toBe(400);

    const badEvent = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { authorization, "idempotency-key": "bad-event" },
      payload: { url: `${receiverUrl}/hook`, events: ["credit.bounced"] },
    });
    expect(badEvent.statusCode).toBe(400);
    expect(badEvent.json().error.message).toMatch(/unknown event type/);
  });

  it("paginates the pull cursor and exposes events once each", async () => {
    await credit("1.00", "DEP-WH-5", "credit-1");
    await credit("2.00", "DEP-WH-6", "credit-2");
    await credit("3.00", "DEP-WH-7", "credit-3");

    const first = await app.inject({
      method: "GET",
      url: "/v1/events?limit=2",
      headers: { authorization },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toHaveLength(2);
    expect(first.json().has_more).toBe(true);
    const cursor = first.json().next_cursor as number;
    expect(cursor).toBeGreaterThan(0);

    const second = await app.inject({
      method: "GET",
      url: `/v1/events?after=${cursor}&limit=2`,
      headers: { authorization },
    });
    expect(second.json().data).toHaveLength(1);
    expect(second.json().has_more).toBe(false);
    expect(second.json().next_cursor).toBeGreaterThan(cursor);

    const none = await app.inject({
      method: "GET",
      url: `/v1/events?after=${second.json().next_cursor}`,
      headers: { authorization },
    });
    expect(none.json().data).toEqual([]);
    expect(none.json().next_cursor).toBe(second.json().next_cursor);
  });

  it("requires webhook scopes, an idempotency key on registration, and keeps the secret write-only", async () => {
    const readOnly = await createApiKey(pool, {
      tenantId,
      pepper: PEPPER,
      scopes: ["accounts:read"],
    });
    const readOnlyAuthorization = `Bearer ${readOnly.key}`;

    const noScope = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { authorization: readOnlyAuthorization, "idempotency-key": "scope-1" },
      payload: { url: `${receiverUrl}/hook`, events: ["credit.posted"] },
    });
    expect(noScope.statusCode).toBe(403);

    const noEventsScope = await app.inject({
      method: "GET",
      url: "/v1/events",
      headers: { authorization: readOnlyAuthorization },
    });
    expect(noEventsScope.statusCode).toBe(403);

    const noKey = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { authorization },
      payload: { url: `${receiverUrl}/hook`, events: ["credit.posted"] },
    });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().error.message).toMatch(/Idempotency-Key/);

    const created = await createSubscription(["credit.posted"], "sub-secret");
    const list = await app.inject({
      method: "GET",
      url: "/v1/webhooks",
      headers: { authorization },
    });
    const subscription = (list.json().data as Array<Record<string, unknown>>)[0];
    expect(subscription).toMatchObject({ id: created.id, status: "active" });
    expect(subscription).not.toHaveProperty("secret");
    expect(JSON.stringify(list.json())).not.toContain(created.secret);
  });

  it("disables a subscription and stops delivering to it", async () => {
    const subscription = await createSubscription(["credit.posted"], "sub-disable");

    const disabled = await app.inject({
      method: "DELETE",
      url: `/v1/webhooks/${subscription.id}`,
      headers: { authorization, "idempotency-key": "disable-1" },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().subscription.status).toBe("disabled");

    await credit("7.00", "DEP-WH-8", "credit-1");
    const summary = await dispatch();
    expect(summary.claimed).toBe(0);
    expect(requests).toHaveLength(0);

    const list = await app.inject({
      method: "GET",
      url: "/v1/webhooks",
      headers: { authorization },
    });
    expect(list.json().data[0]).toMatchObject({ id: subscription.id, status: "disabled" });
  });
});
