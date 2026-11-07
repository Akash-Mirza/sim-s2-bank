import type { PoolClient } from "pg";
import type { StatementDirection, StatementLine } from "../../domain/statement.js";
import type { Queryable } from "./types.js";

export interface StatementAccount {
  id: string;
  tenantId: string;
  iban: string;
  currency: string;
}

export interface DailyLedgerEntryRecord {
  id: string;
  tenantId: string;
  accountId: string;
  businessDate: string;
  openingMinor: bigint;
  closingMinor: bigint;
  creditsMinor: bigint;
  debitsMinor: bigint;
  lineCount: number;
  checksum: string;
  status: "closed";
  closedAt: string;
  closedBy: string;
  createdAt: string;
}

export interface EodStateRecord {
  tenantId: string;
  accountId: string;
  lastClosedBusinessDate: string | null;
  updatedAt: string;
}

interface AccountRow {
  id: string;
  tenant_id: string;
  iban: string;
  currency: string;
}

interface OpeningRow {
  opening_minor: string;
}

interface StatementLineRow {
  id: string;
  type: string;
  status: string;
  value_date: string;
  booking_date: string;
  amount_minor: string;
  currency: string;
  reference: string | null;
  end_to_end_id: string | null;
  remitter_name: string | null;
  direction: "D" | "C";
  balance_after_minor: string | null;
}

interface DailyLedgerEntryRow {
  id: string;
  tenant_id: string;
  account_id: string;
  business_date: string;
  opening_minor: string;
  closing_minor: string;
  credits_minor: string;
  debits_minor: string;
  line_count: number;
  checksum: string;
  status: "closed";
  closed_at: Date;
  closed_by: string;
  created_at: Date;
}

interface EodStateRow {
  tenant_id: string;
  account_id: string;
  last_closed_business_date: string | null;
  updated_at: Date;
}

const DAILY_LEDGER_COLUMNS = `id, tenant_id, account_id, business_date::text AS business_date,
  opening_minor, closing_minor, credits_minor, debits_minor, line_count, checksum, status,
  closed_at, closed_by, created_at`;

const EOD_STATE_COLUMNS = `tenant_id, account_id,
  last_closed_business_date::text AS last_closed_business_date, updated_at`;

function mapEntry(row: DailyLedgerEntryRow): DailyLedgerEntryRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    businessDate: row.business_date,
    openingMinor: BigInt(row.opening_minor),
    closingMinor: BigInt(row.closing_minor),
    creditsMinor: BigInt(row.credits_minor),
    debitsMinor: BigInt(row.debits_minor),
    lineCount: row.line_count,
    checksum: row.checksum,
    status: row.status,
    closedAt: row.closed_at.toISOString(),
    closedBy: row.closed_by,
    createdAt: row.created_at.toISOString(),
  };
}

function mapState(row: EodStateRow): EodStateRecord {
  return {
    tenantId: row.tenant_id,
    accountId: row.account_id,
    lastClosedBusinessDate: row.last_closed_business_date,
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapLine(row: StatementLineRow): StatementLine {
  const direction: StatementDirection = row.direction === "C" ? "credit" : "debit";
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    valueDate: row.value_date,
    bookingDate: row.booking_date,
    amountMinor: BigInt(row.amount_minor),
    currency: row.currency,
    direction,
    reference: row.reference,
    endToEndId: row.end_to_end_id,
    remitter: row.remitter_name,
    balanceAfterMinor: row.balance_after_minor === null ? null : BigInt(row.balance_after_minor),
  };
}

export async function getStatementAccount(
  db: Queryable,
  tenantId: string,
  accountId: string,
): Promise<StatementAccount | null> {
  const result = await db.query<AccountRow>(
    "SELECT id, tenant_id, iban, currency FROM accounts WHERE id = $1 AND tenant_id = $2",
    [accountId, tenantId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return { id: row.id, tenantId: row.tenant_id, iban: row.iban.trim(), currency: row.currency };
}

/**
 * Opening balance is the signed sum of the customer-deposit ledger entries booked
 * before `from`. The account starts at zero, so the first statement opens at zero.
 */
export async function statementOpeningMinor(
  db: Queryable,
  tenantId: string,
  accountId: string,
  from: string,
): Promise<bigint> {
  const result = await db.query<OpeningRow>(
    `SELECT COALESCE(SUM(
              CASE le.direction WHEN 'C' THEN le.amount_minor ELSE -le.amount_minor END
            ), 0)::text AS opening_minor
       FROM ledger_entries le
       JOIN transactions t ON t.id = le.transaction_id
       JOIN accounts a ON a.id = le.account_id
      WHERE le.account_id = $1
        AND a.tenant_id = $2
        AND le.ledger_account = 'customer_deposit'
        AND t.status = 'posted'
        AND t.booking_date < $3::date`,
    [accountId, tenantId, from],
  );
  const row = result.rows[0];
  return row === undefined ? 0n : BigInt(row.opening_minor);
}

export interface LedgerCacheSnapshot {
  ledgerMinor: bigint;
  cacheMinor: bigint;
}

/**
 * Compare the customer ledger with `account_balances.ledger_minor`.
 *
 * The cache is allowed to lag only inside the transaction that updates it; after a
 * commit they must agree. A mismatch is an incident, so statement reads refuse to
 * serve numbers that the ledger cannot back.
 */
export async function ledgerCacheSnapshot(
  db: Queryable,
  tenantId: string,
  accountId: string,
): Promise<LedgerCacheSnapshot | null> {
  const result = await db.query<{ ledger_minor: string; cache_minor: string }>(
    `SELECT b.ledger_minor::text AS cache_minor,
            COALESCE((
              SELECT SUM(CASE le.direction WHEN 'C' THEN le.amount_minor ELSE -le.amount_minor END)
                FROM ledger_entries le
                JOIN transactions t ON t.id = le.transaction_id
               WHERE le.account_id = b.account_id
                 AND le.ledger_account = 'customer_deposit'
                 AND t.status = 'posted'
            ), 0)::text AS ledger_minor
       FROM account_balances b
       JOIN accounts a ON a.id = b.account_id
      WHERE b.account_id = $1 AND a.tenant_id = $2`,
    [accountId, tenantId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return { ledgerMinor: BigInt(row.ledger_minor), cacheMinor: BigInt(row.cache_minor) };
}

/** Statement lines for the inclusive booking-date range, in posting order. */ export async function statementLines(
  db: Queryable,
  tenantId: string,
  accountId: string,
  from: string,
  to: string,
): Promise<StatementLine[]> {
  const result = await db.query<StatementLineRow>(
    `SELECT t.id, t.type, t.status,
            t.value_date::text AS value_date,
            t.booking_date::text AS booking_date,
            t.amount_minor, t.currency, t.reference, t.end_to_end_id, t.remitter_name,
            le.direction, le.balance_after_minor
       FROM transactions t
       JOIN ledger_entries le
         ON le.transaction_id = t.id AND le.ledger_account = 'customer_deposit'
       JOIN accounts a ON a.id = t.account_id
      WHERE t.account_id = $1
        AND a.tenant_id = $2
        AND t.status = 'posted'
        AND t.booking_date >= $3::date
        AND t.booking_date <= $4::date
      ORDER BY t.booking_date ASC, t.posted_at ASC NULLS LAST, t.id ASC`,
    [accountId, tenantId, from, to],
  );
  return result.rows.map(mapLine);
}

export async function getEodState(
  db: Queryable,
  tenantId: string,
  accountId: string,
): Promise<EodStateRecord | null> {
  const result = await db.query<EodStateRow>(
    `SELECT ${EOD_STATE_COLUMNS} FROM eod_state WHERE tenant_id = $1 AND account_id = $2`,
    [tenantId, accountId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapState(row);
}

/** Ensure a state row exists, then lock it so two EOD closes cannot interleave. */
export async function lockEodState(
  client: PoolClient,
  tenantId: string,
  accountId: string,
): Promise<EodStateRecord> {
  await client.query(
    `INSERT INTO eod_state (tenant_id, account_id) VALUES ($1, $2)
     ON CONFLICT (tenant_id, account_id) DO NOTHING`,
    [tenantId, accountId],
  );
  const result = await client.query<EodStateRow>(
    `SELECT ${EOD_STATE_COLUMNS} FROM eod_state
      WHERE tenant_id = $1 AND account_id = $2
      FOR UPDATE`,
    [tenantId, accountId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("eod_state row missing after lock");
  return mapState(row);
}

export async function advanceEodState(
  client: PoolClient,
  tenantId: string,
  accountId: string,
  businessDate: string,
): Promise<EodStateRecord> {
  const result = await client.query<EodStateRow>(
    `UPDATE eod_state
        SET last_closed_business_date = $3, updated_at = now()
      WHERE tenant_id = $1 AND account_id = $2
      RETURNING ${EOD_STATE_COLUMNS}`,
    [tenantId, accountId, businessDate],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("eod_state update returned no row");
  return mapState(row);
}

export async function insertDailyLedgerEntry(
  client: PoolClient,
  input: {
    tenantId: string;
    accountId: string;
    businessDate: string;
    openingMinor: bigint;
    closingMinor: bigint;
    creditsMinor: bigint;
    debitsMinor: bigint;
    lineCount: number;
    checksum: string;
    closedBy: string;
  },
): Promise<DailyLedgerEntryRecord> {
  const result = await client.query<DailyLedgerEntryRow>(
    `INSERT INTO daily_ledger_entries (
       tenant_id, account_id, business_date, opening_minor, closing_minor,
       credits_minor, debits_minor, line_count, checksum, closed_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${DAILY_LEDGER_COLUMNS}`,
    [
      input.tenantId,
      input.accountId,
      input.businessDate,
      input.openingMinor.toString(),
      input.closingMinor.toString(),
      input.creditsMinor.toString(),
      input.debitsMinor.toString(),
      input.lineCount,
      input.checksum,
      input.closedBy,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("daily ledger entry insert returned no row");
  return mapEntry(row);
}

export async function getDailyLedgerEntry(
  db: Queryable,
  tenantId: string,
  accountId: string,
  businessDate: string,
): Promise<DailyLedgerEntryRecord | null> {
  const result = await db.query<DailyLedgerEntryRow>(
    `SELECT ${DAILY_LEDGER_COLUMNS} FROM daily_ledger_entries
      WHERE tenant_id = $1 AND account_id = $2 AND business_date = $3::date`,
    [tenantId, accountId, businessDate],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapEntry(row);
}

export async function listDailyLedgerEntries(
  db: Queryable,
  tenantId: string,
  accountId: string,
  limit: number,
): Promise<DailyLedgerEntryRecord[]> {
  const result = await db.query<DailyLedgerEntryRow>(
    `SELECT ${DAILY_LEDGER_COLUMNS} FROM daily_ledger_entries
      WHERE tenant_id = $1 AND account_id = $2
      ORDER BY business_date DESC
      LIMIT $3`,
    [tenantId, accountId, limit],
  );
  return result.rows.map(mapEntry);
}
