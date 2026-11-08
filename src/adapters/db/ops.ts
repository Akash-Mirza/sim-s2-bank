import type { PoolClient } from "pg";
import type { Queryable } from "./types.js";

export const OPS_ROLES = ["viewer", "operator", "admin"] as const;
export type OpsRole = (typeof OPS_ROLES)[number];

export interface OpsUserRecord {
  id: string;
  email: string;
  displayName: string;
  role: OpsRole;
  status: "active" | "disabled";
  createdAt: string;
  lastLoginAt: string | null;
}

export interface OpsSessionView {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  role: OpsRole;
  userStatus: "active" | "disabled";
  tokenHash: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface AuditEntry {
  id: number;
  tenantId: string | null;
  actor: string;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  requestId: string | null;
  at: string;
}

export interface OpsDeliveryView {
  id: string;
  tenantId: string;
  subscriptionId: string;
  eventId: string;
  status: string;
  attempts: number;
  lastStatusCode: number | null;
  nextRetryAt: string;
  createdAt: string;
}

interface OpsUserRow {
  id: string;
  email: string;
  display_name: string;
  role: OpsRole;
  status: "active" | "disabled";
  created_at: Date;
  last_login_at: Date | null;
}

interface OpsUserWithHashRow extends OpsUserRow {
  password_hash: string;
}

interface OpsSessionRow {
  session_id: string;
  user_id: string;
  email: string;
  display_name: string;
  role: OpsRole;
  user_status: "active" | "disabled";
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
}

interface AuditRow {
  id: string;
  tenant_id: string | null;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  request_id: string | null;
  at: Date;
}

interface DeliveryRow {
  id: string;
  tenant_id: string;
  subscription_id: string;
  event_id: string;
  status: string;
  attempts: number;
  last_status_code: number | null;
  next_retry_at: Date;
  created_at: Date;
}

const USER_COLUMNS = "id, email, display_name, role, status, created_at, last_login_at";

function mapUser(row: OpsUserRow): OpsUserRecord {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
  };
}

export async function insertOpsUser(
  db: Queryable,
  input: { email: string; displayName: string; passwordHash: string; role: OpsRole },
): Promise<OpsUserRecord> {
  const result = await db.query<OpsUserRow>(
    `INSERT INTO ops_users (email, display_name, password_hash, role)
     VALUES (lower($1), $2, $3, $4)
     RETURNING ${USER_COLUMNS}`,
    [input.email, input.displayName, input.passwordHash, input.role],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("ops user insert returned no row");
  return mapUser(row);
}

export async function findOpsUserByEmail(
  db: Queryable,
  email: string,
): Promise<{ user: OpsUserRecord; passwordHash: string } | null> {
  const result = await db.query<OpsUserWithHashRow>(
    `SELECT ${USER_COLUMNS}, password_hash FROM ops_users WHERE email = lower($1)`,
    [email],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return { user: mapUser(row), passwordHash: row.password_hash };
}

export async function listOpsUsers(db: Queryable): Promise<OpsUserRecord[]> {
  const result = await db.query<OpsUserRow>(
    `SELECT ${USER_COLUMNS} FROM ops_users ORDER BY created_at ASC`,
  );
  return result.rows.map(mapUser);
}

export async function markOpsLogin(db: Queryable, userId: string): Promise<void> {
  await db.query("UPDATE ops_users SET last_login_at = now(), updated_at = now() WHERE id = $1", [
    userId,
  ]);
}

export async function insertOpsSession(
  client: PoolClient,
  input: { userId: string; tokenPrefix: string; tokenHash: string; expiresAt: Date },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO ops_sessions (user_id, token_prefix, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [input.userId, input.tokenPrefix, input.tokenHash, input.expiresAt.toISOString()],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("ops session insert returned no row");
  return row.id;
}

export async function findOpsSessionByPrefix(
  db: Queryable,
  prefix: string,
): Promise<OpsSessionView | null> {
  const result = await db.query<OpsSessionRow>(
    `SELECT s.id AS session_id, s.user_id, s.token_hash, s.expires_at, s.revoked_at,
            u.email, u.display_name, u.role, u.status AS user_status
       FROM ops_sessions s
       JOIN ops_users u ON u.id = s.user_id
      WHERE s.token_prefix = $1`,
    [prefix],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    userStatus: row.user_status,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

export async function touchOpsSession(db: Queryable, sessionId: string): Promise<void> {
  await db.query("UPDATE ops_sessions SET last_seen_at = now() WHERE id = $1", [sessionId]);
}

export async function revokeOpsSession(db: Queryable, sessionId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE ops_sessions SET revoked_at = now()
      WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Recent audit rows for the console's Audit tab. Cross-tenant by design. */
export async function listRecentAudit(db: Queryable, limit: number): Promise<AuditEntry[]> {
  const result = await db.query<AuditRow>(
    `SELECT id::text AS id, tenant_id, actor, action, entity_type, entity_id,
            before, after, request_id, at
       FROM audit_log
      ORDER BY at DESC, id DESC
      LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    tenantId: row.tenant_id,
    actor: row.actor,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    before: row.before,
    after: row.after,
    requestId: row.request_id,
    at: row.at.toISOString(),
  }));
}

/** Recent webhook deliveries across tenants, for replaying a failed one. */
export async function listRecentDeliveries(
  db: Queryable,
  limit: number,
): Promise<OpsDeliveryView[]> {
  const result = await db.query<DeliveryRow>(
    `SELECT id, tenant_id, subscription_id, event_id, status, attempts,
            last_status_code, next_retry_at, created_at
       FROM webhook_deliveries
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    subscriptionId: row.subscription_id,
    eventId: row.event_id,
    status: row.status,
    attempts: row.attempts,
    lastStatusCode: row.last_status_code,
    nextRetryAt: row.next_retry_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  }));
}
