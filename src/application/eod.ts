import type { PoolClient } from "pg";
import {
  type DailyLedgerEntryRecord,
  type EodStateRecord,
  advanceEodState,
  getDailyLedgerEntry,
  getEodState,
  getStatementAccount,
  insertDailyLedgerEntry,
  listDailyLedgerEntries,
  lockEodState,
} from "../adapters/db/statements.js";
import type { Queryable } from "../adapters/db/types.js";
import { type Clock, businessDate } from "../config/clock.js";
import { assertEodCloseable, buildEodSnapshot } from "../domain/eod.js";
import { notFound } from "../domain/errors.js";
import type { Statement } from "../domain/statement.js";
import { loadStatement } from "./statements.js";

export interface CloseEodInput {
  tenantId: string;
  accountId: string;
  /** Defaults to the current Asia/Dubai business date. */
  businessDate?: string;
  actor: string;
  requestId?: string;
}

export interface CloseEodResult {
  entry: DailyLedgerEntryRecord;
  state: EodStateRecord;
  statement: Statement;
}

/**
 * Close one business date for one account.
 *
 * Order matters: lock the EOD pointer, enforce sequence, lock the account balance so
 * no posting can slip in mid-close, read the day's statement, then persist the
 * snapshot and advance the pointer in the same transaction.
 */
export async function closeEodTx(
  client: PoolClient,
  clock: Clock,
  input: CloseEodInput,
): Promise<CloseEodResult> {
  const today = businessDate(clock.now());
  const date = input.businessDate ?? today;

  const account = await getStatementAccount(client, input.tenantId, input.accountId);
  if (account === null) throw notFound("account not found");

  const state = await lockEodState(client, input.tenantId, input.accountId);
  assertEodCloseable({
    businessDate: date,
    lastClosed: state.lastClosedBusinessDate,
    today,
  });

  // Serialize against postings: postMovement locks this same row FOR UPDATE.
  await client.query("SELECT 1 FROM account_balances WHERE account_id = $1 FOR UPDATE", [
    input.accountId,
  ]);

  const statement = await loadStatement(client, {
    tenantId: input.tenantId,
    accountId: input.accountId,
    from: date,
    to: date,
  });
  const snapshot = buildEodSnapshot(statement);

  const entry = await insertDailyLedgerEntry(client, {
    tenantId: input.tenantId,
    accountId: input.accountId,
    businessDate: snapshot.businessDate,
    openingMinor: snapshot.openingMinor,
    closingMinor: snapshot.closingMinor,
    creditsMinor: snapshot.creditsMinor,
    debitsMinor: snapshot.debitsMinor,
    lineCount: snapshot.lineCount,
    checksum: snapshot.checksum,
    closedBy: input.actor,
  });

  const nextState = await advanceEodState(
    client,
    input.tenantId,
    input.accountId,
    snapshot.businessDate,
  );

  await client.query(
    `INSERT INTO audit_log (tenant_id, actor, action, entity_type, entity_id, before, after, request_id)
     VALUES ($1, $2, 'eod.closed', 'eod', $3, $4, $5, $6)`,
    [
      input.tenantId,
      input.actor,
      input.accountId,
      JSON.stringify({ last_closed_business_date: state.lastClosedBusinessDate }),
      JSON.stringify({
        business_date: snapshot.businessDate,
        opening_minor: snapshot.openingMinor.toString(),
        closing_minor: snapshot.closingMinor.toString(),
        credits_minor: snapshot.creditsMinor.toString(),
        debits_minor: snapshot.debitsMinor.toString(),
        line_count: snapshot.lineCount,
        checksum: snapshot.checksum,
      }),
      input.requestId ?? null,
    ],
  );

  return { entry, state: nextState, statement };
}

export interface EodSummary {
  state: EodStateRecord | null;
  entries: DailyLedgerEntryRecord[];
}

export async function getEodSummary(
  db: Queryable,
  tenantId: string,
  accountId: string,
  limit: number,
): Promise<EodSummary> {
  const account = await getStatementAccount(db, tenantId, accountId);
  if (account === null) throw notFound("account not found");
  return {
    state: await getEodState(db, tenantId, accountId),
    entries: await listDailyLedgerEntries(db, tenantId, accountId, limit),
  };
}

export async function getEodEntry(
  db: Queryable,
  tenantId: string,
  accountId: string,
  businessDate: string,
): Promise<DailyLedgerEntryRecord | null> {
  const account = await getStatementAccount(db, tenantId, accountId);
  if (account === null) throw notFound("account not found");
  return getDailyLedgerEntry(db, tenantId, accountId, businessDate);
}
