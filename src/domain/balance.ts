import { insufficientFunds } from "./errors.js";

export interface BalanceSnapshot {
  ledgerMinor: bigint;
  pendingMinor: bigint;
  heldMinor: bigint;
}

export function availableMinor(balance: BalanceSnapshot): bigint {
  return balance.ledgerMinor - balance.heldMinor - balance.pendingMinor;
}

export interface MovementOptions {
  /** Held amount consumed by this debit (payout settlement). Never more than held. */
  releaseHeldMinor?: bigint;
}

/**
 * Apply one ledger movement to the customer account.
 * Credit increases the book balance; debit decreases it.
 * The simulator has no overdraft, so a debit can never take available below zero.
 * A debit that consumes a hold (payout settlement) releases that hold in the same step.
 */
export function applyLedgerMovement(
  balance: BalanceSnapshot,
  direction: "D" | "C",
  amountMinor: bigint,
  options: MovementOptions = {},
): BalanceSnapshot {
  if (amountMinor <= 0n) {
    throw new Error("ledger movement amount must be positive");
  }

  const releaseHeldMinor = options.releaseHeldMinor ?? 0n;
  if (releaseHeldMinor < 0n || releaseHeldMinor > balance.heldMinor) {
    throw new Error("released hold must be between zero and the held balance");
  }

  const next: BalanceSnapshot = {
    ledgerMinor:
      direction === "C" ? balance.ledgerMinor + amountMinor : balance.ledgerMinor - amountMinor,
    pendingMinor: balance.pendingMinor,
    heldMinor: balance.heldMinor - releaseHeldMinor,
  };

  if (direction === "D") {
    const available = availableMinor(next);
    if (available < 0n) {
      throw insufficientFunds(availableMinor(balance), amountMinor);
    }
  }

  return next;
}
