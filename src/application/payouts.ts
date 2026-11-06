import type { PoolClient } from "pg";
import {
  type PayoutEventRecord,
  type PayoutRecord,
  appendPayoutEvent,
  getHold,
  insertPayout,
  listPayoutEvents,
  loadHoldForUpdate,
  loadPayoutForUpdateUnscoped,
  setHoldStatus,
  setPayoutHold,
  updatePayout,
} from "../adapters/db/payouts.js";
import type { Clock } from "../config/clock.js";
import type { BalanceSnapshot } from "../domain/balance.js";
import { settlementDate } from "../domain/calendar.js";
import { PAYOUT_MAX_MINOR } from "../domain/constants.js";
import {
  amountOutOfRange,
  invalidBic,
  invalidIban,
  invalidStateTransition,
  notFound,
  validationError,
} from "../domain/errors.js";
import { isUaeIban, isValidIban } from "../domain/iban.js";
import { type PayoutStatus, assertPayoutTransition, nextPayoutStatus } from "../domain/payout.js";
import { createHoldTx, lockAccountBalance, releaseHoldTx } from "./holds.js";
import { postMovementTx } from "./post-movement.js";

const BIC_PATTERN = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

export interface PayoutResult {
  payout: PayoutRecord;
  events: PayoutEventRecord[];
  balance: (BalanceSnapshot & { availableMinor: bigint }) | null;
}

async function auditPayout(
  client: PoolClient,
  input: {
    tenantId: string;
    actor: string;
    action: string;
    payoutId: string;
    before?: unknown;
    after?: unknown;
    requestId?: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (tenant_id, actor, action, entity_type, entity_id, before, after, request_id)
     VALUES ($1, $2, $3, 'payout', $4, $5, $6, $7)`,
    [
      input.tenantId,
      input.actor,
      input.action,
      input.payoutId,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      input.requestId ?? null,
    ],
  );
}

export interface CreatePayoutInput {
  tenantId: string;
  accountId: string;
  amountMinor: bigint;
  reference?: string;
  endToEndId?: string;
  valueDate?: string;
  beneficiary: { name: string; iban: string; bic?: string };
  actor: string;
  requestId?: string;
}

/**
 * Create a local AED payout: validate the beneficiary, resolve the settlement date
 * against the UAE cut-off, then reserve the money with a hold. Ledger stays untouched
 * until settlement.
 */
export async function createPayoutTx(
  client: PoolClient,
  clock: Clock,
  input: CreatePayoutInput,
): Promise<PayoutResult> {
  if (input.amountMinor <= 0n) {
    throw validationError("amount must be greater than zero");
  }
  if (input.amountMinor > PAYOUT_MAX_MINOR) {
    throw amountOutOfRange("a single payout may not exceed AED 500,000.00", {
      max: "500000.00",
    });
  }

  const iban = input.beneficiary.iban.replace(/\s+/g, "").toUpperCase();
  if (!isValidIban(iban) || !isUaeIban(iban)) {
    throw invalidIban("beneficiary IBAN must be a valid 23-character UAE IBAN", { iban });
  }

  const bic = input.beneficiary.bic?.toUpperCase();
  if (bic !== undefined && !BIC_PATTERN.test(bic)) {
    throw invalidBic("beneficiary BIC must be 8 or 11 characters");
  }

  const schedule = settlementDate(clock.now(), input.valueDate);
  await lockAccountBalance(client, input.tenantId, input.accountId);

  const payout = await insertPayout(client, {
    tenantId: input.tenantId,
    accountId: input.accountId,
    amountMinor: input.amountMinor,
    reference: input.reference,
    endToEndId: input.endToEndId,
    beneficiaryName: input.beneficiary.name,
    beneficiaryIban: iban,
    beneficiaryBic: bic,
    scheduledFor: schedule.scheduledFor,
    cutoffAt: schedule.cutoffAt,
  });

  const reserved = await createHoldTx(client, {
    tenantId: input.tenantId,
    accountId: input.accountId,
    amountMinor: input.amountMinor,
    reason: "payout_reserve",
    reference: payout.id,
    actor: input.actor,
    requestId: input.requestId,
  });

  await setPayoutHold(client, payout.id, reserved.hold.id);

  const event = await appendPayoutEvent(client, {
    payoutId: payout.id,
    fromStatus: null,
    toStatus: "created",
    actor: input.actor,
    meta: { hold_id: reserved.hold.id, scheduled_for: schedule.scheduledFor },
  });

  await auditPayout(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    action: "payout.created",
    payoutId: payout.id,
    after: {
      amount_minor: input.amountMinor.toString(),
      status: "created",
      scheduled_for: schedule.scheduledFor,
      hold_id: reserved.hold.id,
    },
    requestId: input.requestId,
  });

  return {
    payout: { ...payout, holdId: reserved.hold.id },
    events: [event],
    balance: reserved.balance,
  };
}

/**
 * Advance a payout one legal step (or to an explicit target). Settlement posts the
 * debit and captures the hold in the same transaction; cancel/fail/return release it.
 */
export async function advancePayoutTx(
  client: PoolClient,
  input: {
    clock: Clock;
    payoutId: string;
    to?: PayoutStatus;
    actor: string;
    requestId?: string;
  },
): Promise<PayoutResult> {
  const current = await loadPayoutForUpdateUnscoped(client, input.payoutId);
  if (current === null) {
    throw notFound("payout not found");
  }

  const to = input.to ?? nextPayoutStatus(current.status);
  if (to === null) {
    throw invalidStateTransition(current.status, "next", []);
  }
  assertPayoutTransition(current.status, to);

  let transactionId: string | undefined;
  let balance: PayoutResult["balance"] = null;

  if (to === "settled") {
    if (current.holdId === null) {
      throw new Error("payout has no reserved hold");
    }
    const hold = await loadHoldForUpdate(client, current.tenantId, current.holdId);
    if (hold === null || hold.status !== "active") {
      throw invalidStateTransition(hold?.status ?? "missing", "captured", ["active"]);
    }

    const movement = await postMovementTx(client, input.clock, {
      tenantId: current.tenantId,
      accountId: current.accountId,
      direction: "debit",
      type: "payout",
      amountMinor: current.amountMinor,
      reference: current.reference ?? undefined,
      endToEndId: current.endToEndId ?? undefined,
      valueDate: current.scheduledFor,
      releaseHeldMinor: current.amountMinor,
      actor: input.actor,
      requestId: input.requestId,
    });

    transactionId = movement.transaction.id;
    await setHoldStatus(client, hold.id, "captured", {
      capturedTransactionId: transactionId,
    });
    balance = movement.balance;
  }

  if (to === "cancelled" || to === "failed" || to === "returned") {
    if (current.holdId !== null) {
      const hold = await getHold(client, current.tenantId, current.holdId);
      if (hold !== null && hold.status === "active") {
        const released = await releaseHoldTx(client, {
          tenantId: current.tenantId,
          holdId: hold.id,
          actor: input.actor,
          requestId: input.requestId,
          reason: `payout_${to}`,
        });
        balance = released.balance;
      }
    }
  }

  const now = input.clock.now().toISOString();
  const updated = await updatePayout(client, {
    payoutId: current.id,
    status: to,
    submittedAt: to === "submitted" ? now : undefined,
    settledAt: to === "settled" ? now : undefined,
    transactionId,
    failureCode: to === "failed" ? "payout_failed" : to === "returned" ? "returned" : undefined,
    failureReason:
      to === "failed"
        ? "the simulated rail rejected the payout"
        : to === "returned"
          ? "the simulated rail returned the funds"
          : undefined,
  });

  await appendPayoutEvent(client, {
    payoutId: current.id,
    fromStatus: current.status,
    toStatus: to,
    actor: input.actor,
    meta: transactionId === undefined ? undefined : { transaction_id: transactionId },
  });

  await auditPayout(client, {
    tenantId: current.tenantId,
    actor: input.actor,
    action: `payout.${to}`,
    payoutId: current.id,
    before: { status: current.status },
    after: { status: to },
    requestId: input.requestId,
  });

  return {
    payout: updated,
    events: await listPayoutEvents(client, current.id),
    balance,
  };
}

/** Return settled funds: post a reversal credit and mark the payout returned. */
export async function reverseSettledPayoutTx(
  client: PoolClient,
  input: { clock: Clock; payoutId: string; actor: string; requestId?: string },
): Promise<PayoutResult> {
  const current = await loadPayoutForUpdateUnscoped(client, input.payoutId);
  if (current === null) {
    throw notFound("payout not found");
  }
  if (current.status !== "settled" || current.transactionId === null) {
    throw invalidStateTransition(current.status, "returned", ["settled"]);
  }
  assertPayoutTransition(current.status, "returned");

  const movement = await postMovementTx(client, input.clock, {
    tenantId: current.tenantId,
    accountId: current.accountId,
    direction: "credit",
    type: "reversal",
    amountMinor: current.amountMinor,
    reference: `RETURN-${current.reference ?? current.id}`,
    reversalOf: current.transactionId,
    actor: input.actor,
    requestId: input.requestId,
  });

  const updated = await updatePayout(client, {
    payoutId: current.id,
    status: "returned",
    failureCode: "returned_after_settlement",
    failureReason: "the simulated rail returned settled funds",
  });

  await appendPayoutEvent(client, {
    payoutId: current.id,
    fromStatus: current.status,
    toStatus: "returned",
    actor: input.actor,
    meta: { transaction_id: movement.transaction.id, reversal_of: current.transactionId },
  });

  await auditPayout(client, {
    tenantId: current.tenantId,
    actor: input.actor,
    action: "payout.returned",
    payoutId: current.id,
    before: { status: current.status },
    after: { status: "returned", transaction_id: movement.transaction.id },
    requestId: input.requestId,
  });

  return {
    payout: updated,
    events: await listPayoutEvents(client, current.id),
    balance: movement.balance,
  };
}
