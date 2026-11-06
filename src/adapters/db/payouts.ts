import type { PoolClient } from "pg";
import type { Queryable } from "./types.js";

export interface HoldRecord {
  id: string;
  tenantId: string;
  accountId: string;
  amountMinor: bigint;
  currency: string;
  reason: string;
  reference: string | null;
  status: "active" | "released" | "expired" | "captured";
  expiresAt: string | null;
  releasedAt: string | null;
  capturedTransactionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PayoutRecord {
  id: string;
  tenantId: string;
  accountId: string;
  amountMinor: bigint;
  currency: string;
  reference: string | null;
  endToEndId: string | null;
  beneficiaryName: string;
  beneficiaryIban: string;
  beneficiaryBic: string | null;
  status:
    | "created"
    | "validated"
    | "submitted"
    | "accepted"
    | "settled"
    | "returned"
    | "failed"
    | "cancelled";
  holdId: string | null;
  transactionId: string | null;
  failureCode: string | null;
  failureReason: string | null;
  scheduledFor: string;
  cutoffAt: string;
  submittedAt: string | null;
  settledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PayoutEventRecord {
  id: string;
  payoutId: string;
  fromStatus: string | null;
  toStatus: string;
  actor: string;
  meta: unknown;
  at: string;
}

interface HoldRow {
  id: string;
  tenant_id: string;
  account_id: string;
  amount_minor: string;
  currency: string;
  reason: string;
  reference: string | null;
  status: HoldRecord["status"];
  expires_at: Date | null;
  released_at: Date | null;
  captured_transaction_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface PayoutRow {
  id: string;
  tenant_id: string;
  account_id: string;
  amount_minor: string;
  currency: string;
  reference: string | null;
  end_to_end_id: string | null;
  beneficiary_name: string;
  beneficiary_iban: string;
  beneficiary_bic: string | null;
  status: PayoutRecord["status"];
  hold_id: string | null;
  transaction_id: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  scheduled_for: string;
  cutoff_at: Date;
  submitted_at: Date | null;
  settled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface PayoutEventRow {
  id: string;
  payout_id: string;
  from_status: string | null;
  to_status: string;
  actor: string;
  meta: unknown;
  at: Date;
}

const HOLD_COLUMNS = `id, tenant_id, account_id, amount_minor, currency, reason, reference, status,
  expires_at, released_at, captured_transaction_id, created_at, updated_at`;

const PAYOUT_COLUMNS = `id, tenant_id, account_id, amount_minor, currency, reference, end_to_end_id,
  beneficiary_name, beneficiary_iban, beneficiary_bic, status, hold_id, transaction_id,
  failure_code, failure_reason, scheduled_for::text AS scheduled_for, cutoff_at,
  submitted_at, settled_at, created_at, updated_at`;

const EVENT_COLUMNS = "id, payout_id, from_status, to_status, actor, meta, at";

function mapHold(row: HoldRow): HoldRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    amountMinor: BigInt(row.amount_minor),
    currency: row.currency,
    reason: row.reason,
    reference: row.reference,
    status: row.status,
    expiresAt: row.expires_at?.toISOString() ?? null,
    releasedAt: row.released_at?.toISOString() ?? null,
    capturedTransactionId: row.captured_transaction_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapPayout(row: PayoutRow): PayoutRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    amountMinor: BigInt(row.amount_minor),
    currency: row.currency,
    reference: row.reference,
    endToEndId: row.end_to_end_id,
    beneficiaryName: row.beneficiary_name,
    beneficiaryIban: row.beneficiary_iban.trim(),
    beneficiaryBic: row.beneficiary_bic?.trim() ?? null,
    status: row.status,
    holdId: row.hold_id,
    transactionId: row.transaction_id,
    failureCode: row.failure_code,
    failureReason: row.failure_reason,
    scheduledFor: row.scheduled_for,
    cutoffAt: row.cutoff_at.toISOString(),
    submittedAt: row.submitted_at?.toISOString() ?? null,
    settledAt: row.settled_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapEvent(row: PayoutEventRow): PayoutEventRecord {
  return {
    id: row.id,
    payoutId: row.payout_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    actor: row.actor,
    meta: row.meta,
    at: row.at.toISOString(),
  };
}

export async function insertHold(
  client: PoolClient,
  input: {
    tenantId: string;
    accountId: string;
    amountMinor: bigint;
    reason: string;
    reference?: string;
    expiresAt?: string;
  },
): Promise<HoldRecord> {
  const result = await client.query<HoldRow>(
    `INSERT INTO holds (tenant_id, account_id, amount_minor, currency, reason, reference, expires_at)
     VALUES ($1, $2, $3, 'AED', $4, $5, $6)
     RETURNING ${HOLD_COLUMNS}`,
    [
      input.tenantId,
      input.accountId,
      input.amountMinor.toString(),
      input.reason,
      input.reference ?? null,
      input.expiresAt ?? null,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("hold insert returned no row");
  return mapHold(row);
}

export async function loadHoldForUpdate(
  client: PoolClient,
  tenantId: string,
  holdId: string,
): Promise<HoldRecord | null> {
  const result = await client.query<HoldRow>(
    `SELECT ${HOLD_COLUMNS} FROM holds WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [holdId, tenantId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapHold(row);
}

export async function getHold(
  db: Queryable,
  tenantId: string,
  holdId: string,
): Promise<HoldRecord | null> {
  const result = await db.query<HoldRow>(
    `SELECT ${HOLD_COLUMNS} FROM holds WHERE id = $1 AND tenant_id = $2`,
    [holdId, tenantId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapHold(row);
}

export async function listHolds(
  db: Queryable,
  tenantId: string,
  accountId: string,
): Promise<HoldRecord[]> {
  const result = await db.query<HoldRow>(
    `SELECT ${HOLD_COLUMNS} FROM holds
      WHERE tenant_id = $1 AND account_id = $2
      ORDER BY created_at DESC`,
    [tenantId, accountId],
  );
  return result.rows.map(mapHold);
}

export async function setHoldStatus(
  client: PoolClient,
  holdId: string,
  status: HoldRecord["status"],
  options: { capturedTransactionId?: string } = {},
): Promise<HoldRecord> {
  const result = await client.query<HoldRow>(
    `UPDATE holds
        SET status = $2,
            released_at = CASE WHEN $2 IN ('released', 'expired') THEN now() ELSE released_at END,
            captured_transaction_id = COALESCE($3, captured_transaction_id),
            updated_at = now()
      WHERE id = $1
      RETURNING ${HOLD_COLUMNS}`,
    [holdId, status, options.capturedTransactionId ?? null],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("hold update returned no row");
  return mapHold(row);
}

export async function insertPayout(
  client: PoolClient,
  input: {
    tenantId: string;
    accountId: string;
    amountMinor: bigint;
    reference?: string;
    endToEndId?: string;
    beneficiaryName: string;
    beneficiaryIban: string;
    beneficiaryBic?: string;
    scheduledFor: string;
    cutoffAt: string;
  },
): Promise<PayoutRecord> {
  const result = await client.query<PayoutRow>(
    `INSERT INTO payouts (
       tenant_id, account_id, amount_minor, currency, reference, end_to_end_id,
       beneficiary_name, beneficiary_iban, beneficiary_bic, status, scheduled_for, cutoff_at
     ) VALUES ($1, $2, $3, 'AED', $4, $5, $6, $7, $8, 'created', $9, $10)
     RETURNING ${PAYOUT_COLUMNS}`,
    [
      input.tenantId,
      input.accountId,
      input.amountMinor.toString(),
      input.reference ?? null,
      input.endToEndId ?? null,
      input.beneficiaryName,
      input.beneficiaryIban,
      input.beneficiaryBic ?? null,
      input.scheduledFor,
      input.cutoffAt,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("payout insert returned no row");
  return mapPayout(row);
}

export async function setPayoutHold(
  client: PoolClient,
  payoutId: string,
  holdId: string,
): Promise<void> {
  await client.query("UPDATE payouts SET hold_id = $2, updated_at = now() WHERE id = $1", [
    payoutId,
    holdId,
  ]);
}

export async function loadPayoutForUpdate(
  client: PoolClient,
  tenantId: string,
  payoutId: string,
): Promise<PayoutRecord | null> {
  const result = await client.query<PayoutRow>(
    `SELECT ${PAYOUT_COLUMNS} FROM payouts WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [payoutId, tenantId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapPayout(row);
}

export async function loadPayoutForUpdateUnscoped(
  client: PoolClient,
  payoutId: string,
): Promise<PayoutRecord | null> {
  const result = await client.query<PayoutRow>(
    `SELECT ${PAYOUT_COLUMNS} FROM payouts WHERE id = $1 FOR UPDATE`,
    [payoutId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapPayout(row);
}

export async function updatePayout(
  client: PoolClient,
  input: {
    payoutId: string;
    status: PayoutRecord["status"];
    submittedAt?: string;
    settledAt?: string;
    transactionId?: string;
    failureCode?: string;
    failureReason?: string;
  },
): Promise<PayoutRecord> {
  const result = await client.query<PayoutRow>(
    `UPDATE payouts
        SET status = $2,
            submitted_at = COALESCE($3, submitted_at),
            settled_at = COALESCE($4, settled_at),
            transaction_id = COALESCE($5, transaction_id),
            failure_code = $6,
            failure_reason = $7,
            updated_at = now()
      WHERE id = $1
      RETURNING ${PAYOUT_COLUMNS}`,
    [
      input.payoutId,
      input.status,
      input.submittedAt ?? null,
      input.settledAt ?? null,
      input.transactionId ?? null,
      input.failureCode ?? null,
      input.failureReason ?? null,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("payout update returned no row");
  return mapPayout(row);
}

export async function getPayout(
  db: Queryable,
  tenantId: string,
  payoutId: string,
): Promise<{ payout: PayoutRecord; events: PayoutEventRecord[] } | null> {
  const result = await db.query<PayoutRow>(
    `SELECT ${PAYOUT_COLUMNS} FROM payouts WHERE id = $1 AND tenant_id = $2`,
    [payoutId, tenantId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return { payout: mapPayout(row), events: await listPayoutEvents(db, payoutId) };
}

export async function getPayoutUnscoped(
  db: Queryable,
  payoutId: string,
): Promise<PayoutRecord | null> {
  const result = await db.query<PayoutRow>(`SELECT ${PAYOUT_COLUMNS} FROM payouts WHERE id = $1`, [
    payoutId,
  ]);
  const row = result.rows[0];
  return row === undefined ? null : mapPayout(row);
}

export async function listPayouts(
  db: Queryable,
  tenantId: string,
  options: { status?: PayoutRecord["status"]; limit: number },
): Promise<PayoutRecord[]> {
  const result = await db.query<PayoutRow>(
    `SELECT ${PAYOUT_COLUMNS} FROM payouts
      WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2)
      ORDER BY created_at DESC
      LIMIT $3`,
    [tenantId, options.status ?? null, options.limit],
  );
  return result.rows.map(mapPayout);
}

export async function appendPayoutEvent(
  client: PoolClient,
  input: {
    payoutId: string;
    fromStatus: string | null;
    toStatus: string;
    actor: string;
    meta?: unknown;
  },
): Promise<PayoutEventRecord> {
  const result = await client.query<PayoutEventRow>(
    `INSERT INTO payout_events (payout_id, from_status, to_status, actor, meta)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${EVENT_COLUMNS}`,
    [
      input.payoutId,
      input.fromStatus,
      input.toStatus,
      input.actor,
      input.meta === undefined ? null : JSON.stringify(input.meta),
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("payout event insert returned no row");
  return mapEvent(row);
}

export async function listPayoutEvents(
  db: Queryable,
  payoutId: string,
): Promise<PayoutEventRecord[]> {
  const result = await db.query<PayoutEventRow>(
    `SELECT ${EVENT_COLUMNS} FROM payout_events WHERE payout_id = $1 ORDER BY at ASC, id ASC`,
    [payoutId],
  );
  return result.rows.map(mapEvent);
}
