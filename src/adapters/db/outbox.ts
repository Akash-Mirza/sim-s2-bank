import type { Pool, PoolClient } from "pg";
import type { Queryable } from "./types.js";

export type DeliveryStatus = "pending" | "delivering" | "delivered" | "failed" | "dead";
export type SubscriptionStatus = "active" | "disabled";

export interface OutboxEventRecord {
  seq: number;
  id: string;
  tenantId: string;
  accountId: string | null;
  type: string;
  payload: unknown;
  publishedAt: string | null;
  createdAt: string;
}

export interface SubscriptionRecord {
  id: string;
  tenantId: string;
  url: string;
  secretEncrypted: string;
  events: string[];
  description: string | null;
  status: SubscriptionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryRecord {
  id: string;
  tenantId: string;
  subscriptionId: string;
  eventId: string;
  status: DeliveryStatus;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: string;
  lastStatusCode: number | null;
  lastError: string | null;
  signature: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A claimed delivery plus everything needed to sign and send it. */
export interface ClaimedDelivery extends DeliveryRecord {
  eventType: string;
  eventPayload: unknown;
  eventCreatedAt: string;
  subscriptionUrl: string;
  subscriptionSecretEncrypted: string;
}

interface OutboxEventRow {
  seq: string;
  id: string;
  tenant_id: string;
  account_id: string | null;
  type: string;
  payload: unknown;
  published_at: Date | null;
  created_at: Date;
}

interface SubscriptionRow {
  id: string;
  tenant_id: string;
  url: string;
  secret_encrypted: string;
  events: string[];
  description: string | null;
  status: SubscriptionStatus;
  created_at: Date;
  updated_at: Date;
}

interface DeliveryRow {
  id: string;
  tenant_id: string;
  subscription_id: string;
  event_id: string;
  status: DeliveryStatus;
  attempts: number;
  max_attempts: number;
  next_retry_at: Date;
  last_status_code: number | null;
  last_error: string | null;
  signature: string | null;
  delivered_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface ClaimedDeliveryRow extends DeliveryRow {
  event_type: string;
  event_payload: unknown;
  event_created_at: Date;
  subscription_url: string;
  subscription_secret_encrypted: string;
}

const EVENT_COLUMNS = "seq, id, tenant_id, account_id, type, payload, published_at, created_at";
const SUBSCRIPTION_COLUMNS =
  "id, tenant_id, url, secret_encrypted, events, description, status, created_at, updated_at";
const DELIVERY_COLUMNS = `id, tenant_id, subscription_id, event_id, status, attempts, max_attempts,
  next_retry_at, last_status_code, last_error, signature, delivered_at, created_at, updated_at`;

function mapEvent(row: OutboxEventRow): OutboxEventRecord {
  return {
    seq: Number(row.seq),
    id: row.id,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    type: row.type,
    payload: row.payload,
    publishedAt: row.published_at === null ? null : row.published_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

function mapSubscription(row: SubscriptionRow): SubscriptionRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    url: row.url,
    secretEncrypted: row.secret_encrypted,
    events: row.events,
    description: row.description,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapDelivery(row: DeliveryRow): DeliveryRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subscriptionId: row.subscription_id,
    eventId: row.event_id,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextRetryAt: row.next_retry_at.toISOString(),
    lastStatusCode: row.last_status_code,
    lastError: row.last_error,
    signature: row.signature,
    deliveredAt: row.delivered_at === null ? null : row.delivered_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Insert one event into the transactional outbox. Callers pass the same client
 * that owns the business change, so both commit or roll back together.
 */
export async function insertOutboxEvent(
  client: PoolClient,
  input: {
    tenantId: string;
    accountId?: string;
    type: string;
    payload: unknown;
  },
): Promise<OutboxEventRecord> {
  const result = await client.query<OutboxEventRow>(
    `INSERT INTO outbox_events (tenant_id, account_id, type, payload)
     VALUES ($1, $2, $3, $4)
     RETURNING ${EVENT_COLUMNS}`,
    [input.tenantId, input.accountId ?? null, input.type, JSON.stringify(input.payload)],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("outbox event insert returned no row");
  return mapEvent(row);
}

export async function insertDelivery(
  client: PoolClient,
  input: { tenantId: string; subscriptionId: string; eventId: string },
): Promise<DeliveryRecord> {
  const result = await client.query<DeliveryRow>(
    `INSERT INTO webhook_deliveries (tenant_id, subscription_id, event_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (subscription_id, event_id) DO NOTHING
     RETURNING ${DELIVERY_COLUMNS}`,
    [input.tenantId, input.subscriptionId, input.eventId],
  );
  let row = result.rows[0];
  if (row === undefined) {
    const existing = await client.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries
        WHERE subscription_id = $1 AND event_id = $2`,
      [input.subscriptionId, input.eventId],
    );
    row = existing.rows[0];
  }
  if (row === undefined) throw new Error("delivery insert returned no row");
  return mapDelivery(row);
}

export async function listActiveSubscriptions(
  db: Queryable,
  tenantId: string,
): Promise<SubscriptionRecord[]> {
  const result = await db.query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM webhook_subscriptions
      WHERE tenant_id = $1 AND status = 'active'
      ORDER BY created_at ASC`,
    [tenantId],
  );
  return result.rows.map(mapSubscription);
}

export async function insertSubscription(
  db: Queryable,
  input: {
    tenantId: string;
    url: string;
    secretEncrypted: string;
    events: string[];
    description?: string;
  },
): Promise<SubscriptionRecord> {
  const result = await db.query<SubscriptionRow>(
    `INSERT INTO webhook_subscriptions (tenant_id, url, secret_encrypted, events, description)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${SUBSCRIPTION_COLUMNS}`,
    [input.tenantId, input.url, input.secretEncrypted, input.events, input.description ?? null],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("subscription insert returned no row");
  return mapSubscription(row);
}

export async function listSubscriptions(
  db: Queryable,
  tenantId: string,
): Promise<SubscriptionRecord[]> {
  const result = await db.query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM webhook_subscriptions
      WHERE tenant_id = $1
      ORDER BY created_at DESC`,
    [tenantId],
  );
  return result.rows.map(mapSubscription);
}

export async function getSubscription(
  db: Queryable,
  tenantId: string,
  subscriptionId: string,
): Promise<SubscriptionRecord | null> {
  const result = await db.query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM webhook_subscriptions
      WHERE id = $1 AND tenant_id = $2`,
    [subscriptionId, tenantId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapSubscription(row);
}

/** Subscriptions are disabled, never deleted: deliveries keep a valid parent. */
export async function disableSubscription(
  db: Queryable,
  tenantId: string,
  subscriptionId: string,
): Promise<SubscriptionRecord | null> {
  const result = await db.query<SubscriptionRow>(
    `UPDATE webhook_subscriptions
        SET status = 'disabled', updated_at = now()
      WHERE id = $1 AND tenant_id = $2
      RETURNING ${SUBSCRIPTION_COLUMNS}`,
    [subscriptionId, tenantId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapSubscription(row);
}

export async function listDeliveries(
  db: Queryable,
  tenantId: string,
  subscriptionId: string,
  limit: number,
): Promise<DeliveryRecord[]> {
  const result = await db.query<DeliveryRow>(
    `SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries
      WHERE tenant_id = $1 AND subscription_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [tenantId, subscriptionId, limit],
  );
  return result.rows.map(mapDelivery);
}

export async function getDelivery(
  db: Queryable,
  tenantId: string,
  deliveryId: string,
): Promise<DeliveryRecord | null> {
  const result = await db.query<DeliveryRow>(
    `SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries WHERE id = $1 AND tenant_id = $2`,
    [deliveryId, tenantId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapDelivery(row);
}

/** Ops-only lookup; the caller has already been authorized by the ops token. */
export async function getDeliveryUnscoped(
  db: Queryable,
  deliveryId: string,
): Promise<DeliveryRecord | null> {
  const result = await db.query<DeliveryRow>(
    `SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries WHERE id = $1`,
    [deliveryId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapDelivery(row);
}

/**
 * Reclaim deliveries stuck in `delivering` after a crash. They become retryable
 * again instead of silently disappearing from the outbox.
 */
export async function requeueStaleDeliveries(db: Pool, staleAfterSeconds: number): Promise<number> {
  const result = await db.query(
    `UPDATE webhook_deliveries
        SET status = 'failed',
            last_error = 'dispatcher stopped while delivering',
            next_retry_at = now(),
            updated_at = now()
      WHERE status = 'delivering'
        AND updated_at < now() - ($1 || ' seconds')::interval`,
    [staleAfterSeconds],
  );
  return result.rowCount ?? 0;
}

/**
 * Claim a batch with `FOR UPDATE SKIP LOCKED`: concurrent dispatchers (or a
 * serverless invocation racing a manual run) never send the same delivery twice.
 */
export async function claimDueDeliveries(
  db: Pool,
  input: { limit: number; tenantId?: string },
): Promise<ClaimedDelivery[]> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<ClaimedDeliveryRow>(
      `WITH due AS (
         SELECT d.id
           FROM webhook_deliveries d
          WHERE d.status IN ('pending', 'failed')
            AND d.next_retry_at <= now()
            AND ($2::uuid IS NULL OR d.tenant_id = $2)
          ORDER BY d.next_retry_at ASC, d.created_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       ),
       claimed AS (
         UPDATE webhook_deliveries d
            SET status = 'delivering', updated_at = now()
           FROM due
          WHERE d.id = due.id
          RETURNING d.*
       )
       SELECT c.*, e.type AS event_type, e.payload AS event_payload,
              e.created_at AS event_created_at,
              s.url AS subscription_url, s.secret_encrypted AS subscription_secret_encrypted
         FROM claimed c
         JOIN outbox_events e ON e.id = c.event_id
         JOIN webhook_subscriptions s ON s.id = c.subscription_id
        ORDER BY c.next_retry_at ASC, c.created_at ASC`,
      [input.limit, input.tenantId ?? null],
    );
    await client.query("COMMIT");

    return result.rows.map((row) => ({
      ...mapDelivery(row),
      eventType: row.event_type,
      eventPayload: row.event_payload,
      eventCreatedAt: row.event_created_at.toISOString(),
      subscriptionUrl: row.subscription_url,
      subscriptionSecretEncrypted: row.subscription_secret_encrypted,
    }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function completeDelivery(
  db: Pool,
  input: {
    deliveryId: string;
    status: "delivered" | "failed" | "dead";
    attempts: number;
    nextRetryAt: string;
    lastStatusCode: number | null;
    lastError: string | null;
    signature: string | null;
  },
): Promise<DeliveryRecord> {
  const result = await db.query<DeliveryRow>(
    `UPDATE webhook_deliveries
        SET status = $2,
            attempts = $3,
            next_retry_at = $4,
            last_status_code = $5,
            last_error = $6,
            signature = $7,
            delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE delivered_at END,
            updated_at = now()
      WHERE id = $1
      RETURNING ${DELIVERY_COLUMNS}`,
    [
      input.deliveryId,
      input.status,
      input.attempts,
      input.nextRetryAt,
      input.lastStatusCode,
      input.lastError,
      input.signature,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("delivery update returned no row");
  return mapDelivery(row);
}

/**
 * An event is published once no delivery remains pending, retrying or in flight.
 * Pull consumers do not depend on this flag; it is the outbox's own progress mark.
 */
export async function markEventPublishedIfSettled(
  db: Queryable,
  eventId: string,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE outbox_events e
        SET published_at = now()
      WHERE e.id = $1
        AND e.published_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM webhook_deliveries d
           WHERE d.event_id = e.id
             AND d.status IN ('pending', 'delivering', 'failed')
        )`,
    [eventId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Reset one delivery so an operator can re-send it; attempts start over. */
export async function requeueDelivery(
  db: Queryable,
  tenantId: string,
  deliveryId: string,
): Promise<DeliveryRecord | null> {
  const result = await db.query<DeliveryRow>(
    `UPDATE webhook_deliveries
        SET status = 'pending',
            attempts = 0,
            next_retry_at = now(),
            last_status_code = NULL,
            last_error = NULL,
            signature = NULL,
            delivered_at = NULL,
            updated_at = now()
      WHERE id = $1 AND tenant_id = $2
      RETURNING ${DELIVERY_COLUMNS}`,
    [deliveryId, tenantId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapDelivery(row);
}

/** Cursor pull for tenants that would rather read events than receive webhooks. */
export async function pullEvents(
  db: Queryable,
  tenantId: string,
  after: number,
  limit: number,
): Promise<OutboxEventRecord[]> {
  const result = await db.query<OutboxEventRow>(
    `SELECT ${EVENT_COLUMNS} FROM outbox_events
      WHERE tenant_id = $1 AND seq > $2
      ORDER BY seq ASC
      LIMIT $3`,
    [tenantId, after, limit],
  );
  return result.rows.map(mapEvent);
}
