import type { PoolClient } from "pg";
import {
  type HoldRecord,
  getHold,
  insertHold,
  loadHoldForUpdate,
  setHoldStatus,
} from "../adapters/db/payouts.js";
import { type BalanceSnapshot, availableMinor } from "../domain/balance.js";
import { CURRENCY } from "../domain/constants.js";
import {
  DomainError,
  insufficientFunds,
  invalidStateTransition,
  validationError,
} from "../domain/errors.js";
import { formatAmountMinor } from "../domain/money.js";
import { enqueueEventTx } from "./outbox.js";

interface LockedBalanceRow {
  status: string;
  currency: string;
  ledger_minor: string;
  pending_minor: string;
  held_minor: string;
}

export interface HoldResult {
  hold: HoldRecord;
  balance: BalanceSnapshot & { availableMinor: bigint };
}

/** Lock the account's balance row and enforce that the account may move money. */
export async function lockAccountBalance(
  client: PoolClient,
  tenantId: string,
  accountId: string,
): Promise<BalanceSnapshot> {
  const locked = await client.query<LockedBalanceRow>(
    `SELECT a.status, a.currency, b.ledger_minor, b.pending_minor, b.held_minor
       FROM accounts a
       JOIN account_balances b ON b.account_id = a.id
      WHERE a.id = $1 AND a.tenant_id = $2
      FOR UPDATE OF b`,
    [accountId, tenantId],
  );

  const row = locked.rows[0];
  if (row === undefined) {
    throw new DomainError("not_found", "account not found", 404);
  }
  if (row.currency !== CURRENCY) {
    throw validationError(`unsupported currency ${row.currency}`);
  }
  if (row.status !== "open") {
    throw new DomainError("account_restricted", `account is ${row.status}`, 423);
  }

  return {
    ledgerMinor: BigInt(row.ledger_minor),
    pendingMinor: BigInt(row.pending_minor),
    heldMinor: BigInt(row.held_minor),
  };
}

async function auditHold(
  client: PoolClient,
  input: {
    tenantId: string;
    actor: string;
    action: string;
    hold: HoldRecord;
    before?: unknown;
    after?: unknown;
    requestId?: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (tenant_id, actor, action, entity_type, entity_id, before, after, request_id)
     VALUES ($1, $2, $3, 'hold', $4, $5, $6, $7)`,
    [
      input.tenantId,
      input.actor,
      input.action,
      input.hold.id,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      input.requestId ?? null,
    ],
  );
}

/**
 * Reserve available balance without moving the ledger.
 * A hold increases `held_minor`; available = ledger - held - pending, so available falls.
 */
export async function createHoldTx(
  client: PoolClient,
  input: {
    tenantId: string;
    accountId: string;
    amountMinor: bigint;
    reason: string;
    reference?: string;
    expiresAt?: string;
    actor: string;
    requestId?: string;
    /** Payout flows emit payout.* events and suppress the underlying hold event. */
    suppressEvents?: boolean;
  },
): Promise<HoldResult> {
  if (input.amountMinor <= 0n) {
    throw validationError("amount must be greater than zero");
  }

  const current = await lockAccountBalance(client, input.tenantId, input.accountId);
  const next: BalanceSnapshot = {
    ledgerMinor: current.ledgerMinor,
    pendingMinor: current.pendingMinor,
    heldMinor: current.heldMinor + input.amountMinor,
  };

  if (availableMinor(next) < 0n) {
    throw insufficientFunds(availableMinor(current), input.amountMinor);
  }

  const hold = await insertHold(client, {
    tenantId: input.tenantId,
    accountId: input.accountId,
    amountMinor: input.amountMinor,
    reason: input.reason,
    reference: input.reference,
    expiresAt: input.expiresAt,
  });

  await client.query(
    `UPDATE account_balances
        SET held_minor = $2, available_minor = $3, version = version + 1, updated_at = now()
      WHERE account_id = $1`,
    [input.accountId, next.heldMinor.toString(), availableMinor(next).toString()],
  );

  await auditHold(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    action: "hold.created",
    hold,
    before: {
      held_minor: current.heldMinor.toString(),
      available_minor: availableMinor(current).toString(),
    },
    after: {
      held_minor: next.heldMinor.toString(),
      available_minor: availableMinor(next).toString(),
      amount_minor: input.amountMinor.toString(),
      reason: input.reason,
    },
    requestId: input.requestId,
  });

  if (input.suppressEvents !== true) {
    await enqueueEventTx(client, {
      tenantId: input.tenantId,
      accountId: input.accountId,
      type: "hold.created",
      payload: {
        hold_id: hold.id,
        account_id: input.accountId,
        amount: formatAmountMinor(input.amountMinor),
        currency: CURRENCY,
        reason: input.reason,
        reference: input.reference ?? null,
        status: hold.status,
        expires_at: hold.expiresAt,
        available: formatAmountMinor(availableMinor(next)),
      },
    });
  }

  return { hold, balance: { ...next, availableMinor: availableMinor(next) } };
}

/**
 * Release an active hold. Releasing an already-released hold is a no-op so the
 * endpoint is safe to retry; a captured hold cannot be released (409).
 */
export async function releaseHoldTx(
  client: PoolClient,
  input: {
    tenantId: string;
    holdId: string;
    actor: string;
    requestId?: string;
    reason?: string;
    suppressEvents?: boolean;
  },
): Promise<HoldResult> {
  const known = await getHold(client, input.tenantId, input.holdId);
  if (known === null) {
    throw new DomainError("not_found", "hold not found", 404);
  }

  const current = await lockAccountBalance(client, input.tenantId, known.accountId);
  const hold = await loadHoldForUpdate(client, input.tenantId, input.holdId);
  if (hold === null) {
    throw new DomainError("not_found", "hold not found", 404);
  }

  if (hold.status === "released") {
    return { hold, balance: { ...current, availableMinor: availableMinor(current) } };
  }
  if (hold.status !== "active") {
    throw invalidStateTransition(hold.status, "released", ["active"]);
  }

  const next: BalanceSnapshot = {
    ledgerMinor: current.ledgerMinor,
    pendingMinor: current.pendingMinor,
    heldMinor: current.heldMinor - hold.amountMinor,
  };
  if (next.heldMinor < 0n) {
    throw new Error("releasing the hold would make the held balance negative");
  }

  await client.query(
    `UPDATE account_balances
        SET held_minor = $2, available_minor = $3, version = version + 1, updated_at = now()
      WHERE account_id = $1`,
    [hold.accountId, next.heldMinor.toString(), availableMinor(next).toString()],
  );

  const released = await setHoldStatus(client, hold.id, "released");

  await auditHold(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    action: "hold.released",
    hold: released,
    before: { held_minor: current.heldMinor.toString(), status: hold.status },
    after: {
      held_minor: next.heldMinor.toString(),
      status: released.status,
      reason: input.reason ?? "manual",
    },
    requestId: input.requestId,
  });

  if (input.suppressEvents !== true) {
    await enqueueEventTx(client, {
      tenantId: input.tenantId,
      accountId: hold.accountId,
      type: "hold.released",
      payload: {
        hold_id: released.id,
        account_id: hold.accountId,
        amount: formatAmountMinor(hold.amountMinor),
        currency: hold.currency,
        reason: input.reason ?? "manual",
        reference: hold.reference,
        status: released.status,
        available: formatAmountMinor(availableMinor(next)),
      },
    });
  }

  return { hold: released, balance: { ...next, availableMinor: availableMinor(next) } };
}
