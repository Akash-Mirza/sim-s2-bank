import type { Pool, PoolClient } from "pg";
import {
  decryptSecret,
  deriveWebhookEncryptionKey,
  encryptSecret,
  generateWebhookSecret,
  signWebhook,
  signatureHeader,
} from "../adapters/crypto/webhooks.js";
import {
  type ClaimedDelivery,
  type DeliveryRecord,
  type OutboxEventRecord,
  type SubscriptionRecord,
  claimDueDeliveries,
  completeDelivery,
  disableSubscription,
  getSubscription,
  insertDelivery,
  insertOutboxEvent,
  insertSubscription,
  listActiveSubscriptions,
  listDeliveries,
  listSubscriptions,
  markEventPublishedIfSettled,
  pullEvents,
  requeueDelivery,
  requeueStaleDeliveries,
} from "../adapters/db/outbox.js";
import type { Queryable } from "../adapters/db/types.js";
import type { Env } from "../config/env.js";
import { DomainError, notFound } from "../domain/errors.js";
import {
  type EventType,
  MAX_EVENT_PAYLOAD_BYTES,
  buildEnvelope,
  matchesEvent,
  retryDelaySeconds,
  serializeEnvelope,
  validateEventFilters,
  validateEventType,
  validateWebhookUrl,
} from "../domain/webhook.js";

export interface EnqueueResult {
  event: OutboxEventRecord;
  deliveries: DeliveryRecord[];
}

/**
 * Write an event and fan it out to every matching active subscription, inside the
 * caller's transaction. A subscription created later never sees past events, and an
 * event that rolls back leaves no delivery behind.
 */
export async function enqueueEventTx(
  client: PoolClient,
  input: { tenantId: string; accountId?: string; type: EventType; payload: unknown },
): Promise<EnqueueResult> {
  validateEventType(input.type);

  const serialized = JSON.stringify(input.payload);
  if (serialized === undefined) {
    throw new DomainError("internal_error", "event payload is not serializable", 500);
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
    throw new DomainError("internal_error", "event payload is too large", 500, {
      max_bytes: MAX_EVENT_PAYLOAD_BYTES,
    });
  }
  if (serialized.startsWith("[") || serialized.startsWith('"') || serialized === "null") {
    throw new DomainError("internal_error", "event payload must be a JSON object", 500);
  }

  const event = await insertOutboxEvent(client, {
    tenantId: input.tenantId,
    accountId: input.accountId,
    type: input.type,
    payload: input.payload,
  });

  const subscriptions = await listActiveSubscriptions(client, input.tenantId);
  const deliveries: DeliveryRecord[] = [];
  for (const subscription of subscriptions) {
    if (!matchesEvent(subscription.events, input.type)) continue;
    deliveries.push(
      await insertDelivery(client, {
        tenantId: input.tenantId,
        subscriptionId: subscription.id,
        eventId: event.id,
      }),
    );
  }

  // No receiver wanted this event: it is already settled, not stuck unpublished.
  if (deliveries.length === 0) {
    await markEventPublishedIfSettled(client, event.id);
  }

  return { event, deliveries };
}

export interface CreateSubscriptionInput {
  tenantId: string;
  url: string;
  events: string[];
  description?: string;
}

export interface CreatedSubscription {
  subscription: SubscriptionRecord;
  /** The plaintext signing secret. Returned once; only the ciphertext is stored. */
  secret: string;
}

export async function createSubscription(
  db: Queryable,
  env: Env,
  input: CreateSubscriptionInput,
): Promise<CreatedSubscription> {
  const url = validateWebhookUrl(input.url, { production: env.nodeEnv === "production" });
  const events = validateEventFilters(input.events);
  const secret = generateWebhookSecret();
  const key = deriveWebhookEncryptionKey({
    webhookSecretKey: env.webhookSecretKey,
    apiKeyPepper: env.apiKeyPepper,
  });

  const subscription = await insertSubscription(db, {
    tenantId: input.tenantId,
    url,
    secretEncrypted: encryptSecret(key, secret),
    events,
    description: input.description,
  });

  return { subscription, secret };
}

export async function getTenantSubscription(
  db: Queryable,
  tenantId: string,
  subscriptionId: string,
): Promise<SubscriptionRecord> {
  const subscription = await getSubscription(db, tenantId, subscriptionId);
  if (subscription === null) throw notFound("webhook subscription not found");
  return subscription;
}

export async function listTenantSubscriptions(
  db: Queryable,
  tenantId: string,
): Promise<SubscriptionRecord[]> {
  return listSubscriptions(db, tenantId);
}

export async function disableTenantSubscription(
  db: Queryable,
  tenantId: string,
  subscriptionId: string,
): Promise<SubscriptionRecord> {
  const subscription = await disableSubscription(db, tenantId, subscriptionId);
  if (subscription === null) throw notFound("webhook subscription not found");
  return subscription;
}

export async function listTenantDeliveries(
  db: Queryable,
  tenantId: string,
  subscriptionId: string,
  limit: number,
): Promise<DeliveryRecord[]> {
  await getTenantSubscription(db, tenantId, subscriptionId);
  return listDeliveries(db, tenantId, subscriptionId, limit);
}

export async function replayTenantDelivery(
  db: Queryable,
  tenantId: string,
  deliveryId: string,
): Promise<DeliveryRecord> {
  const delivery = await requeueDelivery(db, tenantId, deliveryId);
  if (delivery === null) throw notFound("webhook delivery not found");
  return delivery;
}

export interface EventPage {
  events: OutboxEventRecord[];
  nextCursor: number;
}

export async function pullTenantEvents(
  db: Queryable,
  tenantId: string,
  after: number,
  limit: number,
): Promise<EventPage> {
  const events = await pullEvents(db, tenantId, after, limit);
  const last = events[events.length - 1];
  return { events, nextCursor: last === undefined ? after : last.seq };
}

export interface DispatchSummary {
  claimed: number;
  delivered: number;
  failed: number;
  dead: number;
  requeuedStale: number;
}

export interface DispatchDeps {
  db: Pool;
  env: Env;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock; defaults to the system clock. */
  now?: () => Date;
  staleAfterSeconds?: number;
}

const DELIVERY_TIMEOUT_MS = 5_000;
const MAX_ERROR_LENGTH = 1_000;

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text;
}

/**
 * Send one claimed delivery. A 2xx is success; anything else (including a network
 * error or timeout) is a failed attempt that either retries with backoff or, once
 * `max_attempts` is reached, becomes dead.
 */
async function deliverOne(
  deps: DispatchDeps,
  delivery: ClaimedDelivery,
  key: Buffer,
  now: Date,
): Promise<"delivered" | "failed" | "dead"> {
  const envelope = buildEnvelope({
    id: delivery.eventId,
    type: delivery.eventType,
    createdAt: delivery.eventCreatedAt,
    payload: delivery.eventPayload,
  });
  const body = serializeEnvelope(envelope);
  const timestamp = Math.floor(now.getTime() / 1_000);

  let secret: string;
  try {
    secret = decryptSecret(key, delivery.subscriptionSecretEncrypted);
  } catch (error) {
    const attempts = delivery.attempts;
    const terminal = attempts >= delivery.maxAttempts;
    await completeDelivery(deps.db, {
      deliveryId: delivery.id,
      status: terminal ? "dead" : "failed",
      attempts,
      nextRetryAt: new Date(now.getTime() + retryDelaySeconds(attempts) * 1_000).toISOString(),
      lastStatusCode: null,
      lastError: `cannot decrypt signing secret: ${errorText(error)}`,
      signature: null,
    });
    return terminal ? "dead" : "failed";
  }

  const signature = signatureHeader(timestamp, signWebhook(secret, timestamp, body));

  let statusCode: number | null = null;
  let failure: string | null = null;
  try {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const response = await fetchImpl(delivery.subscriptionUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": `sim-s2-bank/${deps.env.version}`,
        "x-sim-event": delivery.eventType,
        "x-sim-delivery": delivery.id,
        "x-sim-attempt": String(delivery.attempts + 1),
        "x-sim-signature": signature,
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    statusCode = response.status;
    await response.arrayBuffer().catch(() => undefined);
    if (!response.ok) failure = `receiver returned ${response.status}`;
  } catch (error) {
    failure = errorText(error);
  }

  const attempts = delivery.attempts + 1;
  if (failure === null) {
    await completeDelivery(deps.db, {
      deliveryId: delivery.id,
      status: "delivered",
      attempts,
      nextRetryAt: now.toISOString(),
      lastStatusCode: statusCode,
      lastError: null,
      signature,
    });
    return "delivered";
  }

  const terminal = attempts >= delivery.maxAttempts;
  await completeDelivery(deps.db, {
    deliveryId: delivery.id,
    status: terminal ? "dead" : "failed",
    attempts,
    nextRetryAt: new Date(now.getTime() + retryDelaySeconds(attempts) * 1_000).toISOString(),
    lastStatusCode: statusCode,
    lastError: failure,
    signature,
  });
  return terminal ? "dead" : "failed";
}

/**
 * Drain due deliveries. Safe to call concurrently: rows are claimed with
 * `FOR UPDATE SKIP LOCKED`, and an event is marked published only once every one of
 * its deliveries has settled.
 */
export async function dispatchOutbox(
  deps: DispatchDeps,
  options: { limit: number; tenantId?: string },
): Promise<DispatchSummary> {
  const now = deps.now?.() ?? new Date();
  const requeuedStale = await requeueStaleDeliveries(deps.db, deps.staleAfterSeconds ?? 300);
  const claimed = await claimDueDeliveries(deps.db, {
    limit: options.limit,
    tenantId: options.tenantId,
  });

  const key = deriveWebhookEncryptionKey({
    webhookSecretKey: deps.env.webhookSecretKey,
    apiKeyPepper: deps.env.apiKeyPepper,
  });

  const summary: DispatchSummary = {
    claimed: claimed.length,
    delivered: 0,
    failed: 0,
    dead: 0,
    requeuedStale,
  };
  const touchedEvents = new Set<string>();

  for (const delivery of claimed) {
    const outcome = await deliverOne(deps, delivery, key, now);
    summary[outcome] += 1;
    touchedEvents.add(delivery.eventId);
  }

  for (const eventId of touchedEvents) {
    await markEventPublishedIfSettled(deps.db, eventId);
  }

  return summary;
}
