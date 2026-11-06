import { type Account, mapAccount } from "../../application/create-account.js";
import { validationError } from "../../domain/errors.js";
import type { Queryable } from "./types.js";

export interface Balance {
  accountId: string;
  availableMinor: bigint;
  pendingMinor: bigint;
  heldMinor: bigint;
  ledgerMinor: bigint;
  version: bigint;
  updatedAt: string;
}

export interface AccountWithBalance {
  account: Account;
  balance: Balance;
}

export interface TransactionView {
  id: string;
  type: string;
  status: string;
  amountMinor: bigint;
  currency: string;
  reference: string | null;
  valueDate: string;
  bookingDate: string;
  postedAt: string;
}

interface AccountRow {
  id: string;
  tenant_id: string;
  account_number: string;
  iban: string;
  bic: string;
  currency: string;
  product_code: string;
  status: "open" | "restricted" | "closed";
  opened_at: Date;
}

interface BalanceRow {
  account_id: string;
  available_minor: string;
  pending_minor: string;
  held_minor: string;
  ledger_minor: string;
  version: string;
  updated_at: Date;
}

interface TransactionRow {
  id: string;
  type: string;
  status: string;
  amount_minor: string;
  currency: string;
  reference: string | null;
  value_date: string;
  booking_date: string;
  posted_at: Date | null;
}

function mapBalance(row: BalanceRow): Balance {
  return {
    accountId: row.account_id,
    availableMinor: BigInt(row.available_minor),
    pendingMinor: BigInt(row.pending_minor),
    heldMinor: BigInt(row.held_minor),
    ledgerMinor: BigInt(row.ledger_minor),
    version: BigInt(row.version),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapTransaction(row: TransactionRow): TransactionView {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    amountMinor: BigInt(row.amount_minor),
    currency: row.currency,
    reference: row.reference,
    valueDate: row.value_date,
    bookingDate: row.booking_date,
    postedAt: (row.posted_at ?? new Date()).toISOString(),
  };
}

const ACCOUNT_WITH_BALANCE_SELECT = `
  SELECT a.id, a.tenant_id, a.account_number, a.iban, a.bic, a.currency,
         a.product_code, a.status, a.opened_at,
         b.account_id, b.available_minor, b.pending_minor, b.held_minor,
         b.ledger_minor, b.version, b.updated_at
    FROM accounts a
    JOIN account_balances b ON b.account_id = a.id
`;

type JoinedRow = AccountRow & BalanceRow;

export async function getAccount(
  db: Queryable,
  tenantId: string,
  accountId: string,
): Promise<AccountWithBalance | null> {
  const result = await db.query<JoinedRow>(
    `${ACCOUNT_WITH_BALANCE_SELECT} WHERE a.id = $1 AND a.tenant_id = $2`,
    [accountId, tenantId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return { account: mapAccount(row), balance: mapBalance(row) };
}

/** Ops-side lookup: the simulator operator may address any tenant's account. */
export async function getAccountUnscoped(
  db: Queryable,
  accountId: string,
): Promise<AccountWithBalance | null> {
  const result = await db.query<JoinedRow>(`${ACCOUNT_WITH_BALANCE_SELECT} WHERE a.id = $1`, [
    accountId,
  ]);
  const row = result.rows[0];
  if (row === undefined) return null;
  return { account: mapAccount(row), balance: mapBalance(row) };
}

export async function listAccounts(db: Queryable, tenantId: string): Promise<AccountWithBalance[]> {
  const result = await db.query<JoinedRow>(
    `${ACCOUNT_WITH_BALANCE_SELECT} WHERE a.tenant_id = $1 ORDER BY a.opened_at ASC`,
    [tenantId],
  );
  return result.rows.map((row) => ({ account: mapAccount(row), balance: mapBalance(row) }));
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(postedAt: Date, id: string): string {
  return Buffer.from(`${postedAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { postedAt: string; id: string } {
  let raw: string;
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw validationError("invalid cursor");
  }
  const separator = raw.lastIndexOf("|");
  const postedAt = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  if (separator <= 0 || Number.isNaN(Date.parse(postedAt)) || !UUID_PATTERN.test(id)) {
    throw validationError("invalid cursor");
  }
  return { postedAt, id };
}

export async function listTransactions(
  db: Queryable,
  tenantId: string,
  accountId: string,
  options: { limit: number; cursor?: string },
): Promise<{ data: TransactionView[]; nextCursor: string | null }> {
  const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor);
  const result = await db.query<TransactionRow>(
    `SELECT t.id, t.type, t.status, t.amount_minor, t.currency, t.reference,
            t.value_date::text AS value_date, t.booking_date::text AS booking_date, t.posted_at
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE a.id = $1 AND a.tenant_id = $2
        AND (
          $3::timestamptz IS NULL
          OR (t.posted_at, t.id) < ($3::timestamptz, $4::uuid)
        )
      ORDER BY t.posted_at DESC, t.id DESC
      LIMIT $5`,
    [accountId, tenantId, cursor?.postedAt ?? null, cursor?.id ?? null, options.limit + 1],
  );

  const hasMore = result.rows.length > options.limit;
  const page = hasMore ? result.rows.slice(0, options.limit) : result.rows;
  const last = page[page.length - 1];

  return {
    data: page.map(mapTransaction),
    nextCursor:
      hasMore && last !== undefined ? encodeCursor(last.posted_at ?? new Date(), last.id) : null,
  };
}
