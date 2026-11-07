import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { DeliveryRecord, SubscriptionRecord } from "../../adapters/db/outbox.js";
import {
  createSubscription,
  disableTenantSubscription,
  dispatchOutbox,
  listTenantDeliveries,
  listTenantSubscriptions,
  pullTenantEvents,
} from "../../application/outbox.js";
import type { Env } from "../../config/env.js";
import { MODE } from "../../domain/constants.js";
import { forbidden } from "../../domain/errors.js";
import { type Principal, authenticate } from "../auth.js";
import { requireIdempotencyKey, withIdempotency } from "../idempotency.js";

export interface WebhookRouteDeps {
  db: Pool;
  env: Env;
}

const createBody = z.object({
  url: z.string().min(1).max(2_048),
  events: z.array(z.string().min(1).max(64)).min(1).max(32),
  description: z.string().max(280).optional(),
});

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const pullQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const dispatchBody = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const idParams = z.object({ id: z.string().uuid() });

function requireScope(principal: Principal, scope: string): void {
  if (!principal.scopes.includes(scope)) {
    throw forbidden(`api key lacks ${scope} scope`);
  }
}

export function serializeSubscription(subscription: SubscriptionRecord) {
  return {
    id: subscription.id,
    url: subscription.url,
    events: subscription.events,
    description: subscription.description,
    status: subscription.status,
    created_at: subscription.createdAt,
    updated_at: subscription.updatedAt,
  };
}

export function serializeDelivery(delivery: DeliveryRecord) {
  return {
    id: delivery.id,
    subscription_id: delivery.subscriptionId,
    event_id: delivery.eventId,
    status: delivery.status,
    attempts: delivery.attempts,
    max_attempts: delivery.maxAttempts,
    next_retry_at: delivery.nextRetryAt,
    last_status_code: delivery.lastStatusCode,
    last_error: delivery.lastError,
    signature: delivery.signature,
    delivered_at: delivery.deliveredAt,
    created_at: delivery.createdAt,
    updated_at: delivery.updatedAt,
  };
}

export function registerWebhookRoutes(app: FastifyInstance, deps: WebhookRouteDeps): void {
  const { db, env } = deps;

  /** Register a receiver. The signing secret is returned here, never on reads. */
  app.post("/v1/webhooks", async (request, reply) => {
    const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
    requireScope(principal, "webhooks:write");

    const body = createBody.parse(request.body ?? {});
    const key = requireIdempotencyKey(request);

    const result = await withIdempotency(
      {
        db,
        tenantId: principal.tenantId,
        key,
        method: request.method,
        route: request.routeOptions.url ?? request.url,
        body,
      },
      async (client) => {
        const created = await createSubscription(client, env, {
          tenantId: principal.tenantId,
          url: body.url,
          events: body.events,
          description: body.description,
        });

        return {
          status: 201,
          body: {
            mode: MODE,
            subscription: serializeSubscription(created.subscription),
            secret: created.secret,
            signature_header: "x-sim-signature",
            signature_format: "t=<unix>,v1=<hex hmac-sha256 of `${t}.${body}`>",
          },
        };
      },
    );

    if (result.replayed) reply.header("idempotent-replayed", "true");
    return reply.status(result.status).send(result.body);
  });

  app.get("/v1/webhooks", async (request) => {
    const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
    requireScope(principal, "webhooks:read");

    const subscriptions = await listTenantSubscriptions(db, principal.tenantId);
    return { mode: MODE, data: subscriptions.map(serializeSubscription) };
  });

  /** Subscriptions are disabled, not deleted: delivery history keeps its parent. */
  app.delete<{ Params: { id: string } }>("/v1/webhooks/:id", async (request, reply) => {
    const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
    requireScope(principal, "webhooks:write");

    const params = idParams.parse(request.params);
    const key = requireIdempotencyKey(request);

    const result = await withIdempotency(
      {
        db,
        tenantId: principal.tenantId,
        key,
        method: request.method,
        route: request.routeOptions.url ?? request.url,
        body: { subscription_id: params.id },
      },
      async (client) => {
        const disabled = await disableTenantSubscription(client, principal.tenantId, params.id);
        return {
          status: 200,
          body: { mode: MODE, subscription: serializeSubscription(disabled) },
        };
      },
    );

    if (result.replayed) reply.header("idempotent-replayed", "true");
    return reply.status(result.status).send(result.body);
  });

  app.get<{ Params: { id: string } }>("/v1/webhooks/:id/deliveries", async (request) => {
    const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
    requireScope(principal, "webhooks:read");

    const params = idParams.parse(request.params);
    const query = listQuery.parse(request.query ?? {});
    const deliveries = await listTenantDeliveries(db, principal.tenantId, params.id, query.limit);

    return { mode: MODE, data: deliveries.map(serializeDelivery) };
  });

  /** Cursor pull: read events instead of receiving webhooks. `after` is the last seq. */
  app.get("/v1/events", async (request) => {
    const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
    requireScope(principal, "events:read");

    const query = pullQuery.parse(request.query ?? {});
    const page = await pullTenantEvents(db, principal.tenantId, query.after, query.limit);

    return {
      mode: MODE,
      data: page.events.map((event) => ({
        seq: event.seq,
        id: event.id,
        type: event.type,
        account_id: event.accountId,
        data: event.payload,
        created_at: event.createdAt,
      })),
      next_cursor: page.nextCursor,
      has_more: page.events.length === query.limit,
    };
  });

  /**
   * Drain this tenant's due deliveries. Deliberately exempt from Idempotency-Key:
   * it is a worker tick, not a business write, and replaying it must actually run.
   */
  app.post("/v1/outbox/dispatch", async (request) => {
    const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
    requireScope(principal, "webhooks:write");

    const body = dispatchBody.parse(request.body ?? {});
    const summary = await dispatchOutbox(
      { db, env },
      { limit: body.limit, tenantId: principal.tenantId },
    );
    return { mode: MODE, dispatch: summary };
  });
}
