import { DomainError, invalidStateTransition } from "./errors.js";

export const PAYOUT_STATUSES = [
  "created",
  "validated",
  "submitted",
  "accepted",
  "settled",
  "returned",
  "failed",
  "cancelled",
] as const;

export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/**
 * The payout state machine (A5 §16.2).
 *
 * requested (created) -> validated -> submitted -> accepted -> settled
 *                              \-> failed            \-> returned
 * A settled payout can still be returned by the rail; that is the reversal path.
 */
const TRANSITIONS: Record<PayoutStatus, readonly PayoutStatus[]> = {
  created: ["validated", "failed", "cancelled"],
  validated: ["submitted", "failed", "cancelled"],
  submitted: ["accepted", "failed", "returned"],
  accepted: ["settled", "returned", "failed"],
  settled: ["returned"],
  returned: [],
  failed: [],
  cancelled: [],
};

export const NEXT_STATUS: Record<PayoutStatus, PayoutStatus | null> = {
  created: "validated",
  validated: "submitted",
  submitted: "accepted",
  accepted: "settled",
  settled: null,
  returned: null,
  failed: null,
  cancelled: null,
};

export function allowedTransitions(from: PayoutStatus): readonly PayoutStatus[] {
  return TRANSITIONS[from];
}

export function assertPayoutTransition(from: PayoutStatus, to: PayoutStatus): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw invalidStateTransition(from, to, TRANSITIONS[from]);
  }
}

export function nextPayoutStatus(from: PayoutStatus): PayoutStatus | null {
  return NEXT_STATUS[from];
}

export function isTerminalPayoutStatus(status: PayoutStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Holds follow their own, smaller machine (A5 §16.3). */
export const HOLD_STATUSES = ["active", "released", "expired", "captured"] as const;
export type HoldStatus = (typeof HOLD_STATUSES)[number];

export function assertHoldRelease(status: HoldStatus): void {
  if (status !== "active") {
    throw new DomainError(
      "invalid_state_transition",
      `hold is ${status}, only an active hold can be released`,
      409,
      { from: status, to: "released", allowed: ["active"] },
    );
  }
}
