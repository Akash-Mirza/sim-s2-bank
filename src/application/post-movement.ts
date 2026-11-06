import type { Pool, PoolClient } from "pg";
import { type Clock, businessDate } from "../config/clock.js";
import { type BalanceSnapshot, applyLedgerMovement, availableMinor } from "../domain/balance.js";
import { CURRENCY, type TransactionType } from "../domain/constants.js";
import { DomainError, validationError } from "../domain/errors.js";
import { type Direction, assertBalanced, creditLines, debitLines } from "../domain/ledger.js";

export interface Remitter {
  name: string;
  iban?: string;
  bic?: string;
}

export interface PostMovementInput {
  tenantId: string;
  accountId: string;
  direction: "credit" | "debit";
  type: TransactionType;
  amountMinor: bigint;
  reference?: string;
  endToEndId?: string;
  remitter?: Remitter;
  valueDate?: string;
  actor: string;
  requestId?: string;
}

export interface PostedTransaction {
  id: string;
  type: TransactionType;
  status: "posted";
  amountMinor: bigint;
  currency: string;
  reference: string | null;
  valueDate: string;
  bookingDate: string;
  postedAt: string;
}

export interface MovementResult {
  transaction: PostedTransaction;
  balance: BalanceSnapshot & { availableMinor: bigint };
}

interface LockedAccountRow {
  id: string;
  status: string;
  currency: string;
  ledger_minor: string;
  pending_minor: string;
  held_minor: string;
}

const VALUE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function resolveDates(
  now: Date,
  valueDate: string | undefined,
): { value: string; booking: string } {
  const today = businessDate(now);
  if (valueDate === undefined) return { value: today, booking: today };
  if (!VALUE_DATE_PATTERN.test(valueDate) || Number.isNaN(Date.parse(valueDate))) {
    throw validationError("value_date must be an ISO date (YYYY-MM-DD)");
  }
  return { value: valueDate, booking: today };
}

/**
 * Post one balanced movement inside a single database transaction:
 * lock the balance row, enforce the rule, insert entries, update the cache, audit.
 */
export async function postMovement(
  deps: { db: Pool; clock: Clock },
  input: PostMovementInput,
): Promise<MovementResult> {
  if (input.amountMinor <= 0n) {
    throw validationError("amount must be greater than zero");
  }

  const direction: Direction = input.direction === "credit" ? "C" : "D";
  const lines =
    input.direction === "credit" ? creditLines(input.amountMinor) : debitLines(input.amountMinor);
  assertBalanced(lines);

  const { value, booking } = resolveDates(deps.clock.now(), input.valueDate);
  const client: PoolClient = await deps.db.connect();

  try {
    await client.query("BEGIN");

    const locked = await client.query<LockedAccountRow>(
      `SELECT a.id, a.status, a.currency, b.ledger_minor, b.pending_minor, b.held_minor
         FROM accounts a
         JOIN account_balances b ON b.account_id = a.id
        WHERE a.id = $1 AND a.tenant_id = $2
        FOR UPDATE OF b`,
      [input.accountId, input.tenantId],
    );

    const account = locked.rows[0];
    if (account === undefined) {
      throw new DomainError("not_found", "account not found", 404);
    }
    if (account.currency !== CURRENCY) {
      throw validationError(`unsupported currency ${account.currency}`);
    }
    if (account.status !== "open") {
      throw new DomainError("account_restricted", `account is ${account.status}`, 423);
    }

    const current: BalanceSnapshot = {
      ledgerMinor: BigInt(account.ledger_minor),
      pendingMinor: BigInt(account.pending_minor),
      heldMinor: BigInt(account.held_minor),
    };
    const next = applyLedgerMovement(current, direction, input.amountMinor);

    const inserted = await client.query<{ id: string; posted_at: Date }>(
      `INSERT INTO transactions (
         account_id, type, status, amount_minor, currency, reference, end_to_end_id,
         remitter_name, remitter_iban, remitter_bic, value_date, booking_date, posted_at
       ) VALUES ($1, $2, 'posted', $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
       RETURNING id, posted_at`,
      [
        input.accountId,
        input.type,
        input.amountMinor.toString(),
        CURRENCY,
        input.reference ?? null,
        input.endToEndId ?? null,
        input.remitter?.name ?? null,
        input.remitter?.iban ?? null,
        input.remitter?.bic ?? null,
        value,
        booking,
      ],
    );

    const transaction = inserted.rows[0];
    if (transaction === undefined) throw new Error("transaction insert returned no row");

    for (const line of lines) {
      const isCustomerLeg = line.ledgerAccount === "customer_deposit";
      await client.query(
        `INSERT INTO ledger_entries (
           transaction_id, account_id, ledger_account, direction, amount_minor,
           currency, balance_after_minor, value_date, booking_date
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          transaction.id,
          input.accountId,
          line.ledgerAccount,
          line.direction,
          line.amountMinor.toString(),
          CURRENCY,
          isCustomerLeg ? next.ledgerMinor.toString() : null,
          value,
          booking,
        ],
      );
    }

    await client.query(
      `UPDATE account_balances
          SET ledger_minor = $2, available_minor = $3, version = version + 1, updated_at = now()
        WHERE account_id = $1`,
      [input.accountId, next.ledgerMinor.toString(), availableMinor(next).toString()],
    );

    await client.query(
      `INSERT INTO audit_log (tenant_id, actor, action, entity_type, entity_id, before, after, request_id)
       VALUES ($1, $2, $3, 'transaction', $4, $5, $6, $7)`,
      [
        input.tenantId,
        input.actor,
        `transaction.${input.direction}_posted`,
        transaction.id,
        JSON.stringify({
          ledger_minor: current.ledgerMinor.toString(),
          available_minor: availableMinor(current).toString(),
        }),
        JSON.stringify({
          ledger_minor: next.ledgerMinor.toString(),
          available_minor: availableMinor(next).toString(),
          amount_minor: input.amountMinor.toString(),
        }),
        input.requestId ?? null,
      ],
    );

    await client.query("COMMIT");

    return {
      transaction: {
        id: transaction.id,
        type: input.type,
        status: "posted",
        amountMinor: input.amountMinor,
        currency: CURRENCY,
        reference: input.reference ?? null,
        valueDate: value,
        bookingDate: booking,
        postedAt: transaction.posted_at.toISOString(),
      },
      balance: {
        ...next,
        availableMinor: availableMinor(next),
      },
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
