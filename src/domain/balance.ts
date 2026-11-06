import { insufficientFunds } from "./errors.js";

export interface BalanceSnapshot {
  ledgerMinor: bigint;
  pendingMinor: bigint;
  heldMinor: bigint;
}

export function availableMinor(balance: BalanceSnapshot): bigint {
  return balance.ledgerMinor - balance.heldMinor - balance.pendingMinor;
}

/**
 * Apply one ledger movement to the customer account.
 * Credit increases the book balance; debit decreases it.
 * The simulator has no overdraft, so a debit can never take available below zero.
 */
export function applyLedgerMovement(
  balance: BalanceSnapshot,
  direction: "D" | "C",
  amountMinor: bigint,
): BalanceSnapshot {
  if (amountMinor <= 0n) {
    throw new Error("ledger movement amount must be positive");
  }

  const next: BalanceSnapshot = {
    ledgerMinor:
      direction === "C" ? balance.ledgerMinor + amountMinor : balance.ledgerMinor - amountMinor,
    pendingMinor: balance.pendingMinor,
    heldMinor: balance.heldMinor,
  };

  if (direction === "D") {
    const available = availableMinor(next);
    if (available < 0n) {
      throw insufficientFunds(availableMinor(balance), amountMinor);
    }
  }

  return next;
}
