import { validationError } from "./errors.js";
import type { PayoutStatus } from "./payout.js";

/**
 * The four failure scenarios the simulator can arm against a payout (A7 `S2-09`).
 *
 * A scenario is not a second state machine: it bends or refuses one existing
 * transition, so the ledger, the hold and the payout history keep their single
 * source of truth.
 */
export const SCENARIO_KINDS = ["underpaid", "sanctions_hold", "bank_timeout", "returned"] as const;
export type ScenarioKind = (typeof SCENARIO_KINDS)[number];

export const SCENARIO_STATUSES = ["armed", "consumed", "disarmed"] as const;
export type ScenarioStatus = (typeof SCENARIO_STATUSES)[number];

export const SCENARIO_DESCRIPTIONS: Record<ScenarioKind, string> = {
  underpaid:
    "the beneficiary bank receives less than the payout amount; the shortfall returns to the payer",
  sanctions_hold:
    "the payout is held for sanctions review and cannot be accepted or settled until disarmed",
  bank_timeout:
    "the simulated rail times out while accepting the payout; the payout stays submitted",
  returned: "the simulated rail returns the payout before settlement and the reserve is released",
};

export interface ScenarioBlock {
  code: "payment_held" | "rail_timeout";
  message: string;
  statusCode: number;
  details: Record<string, unknown>;
}

export interface ScenarioResolution {
  /** The transition target after the scenario is applied. */
  to: PayoutStatus;
  /** Minor units debited at settlement; null when this step does not settle. */
  settleMinor: bigint | null;
  /** Set when the scenario refuses the step instead of bending it. */
  block: ScenarioBlock | null;
  /** True when the scenario has done its job and must not fire again. */
  consumes: boolean;
  /** Which scenario produced this resolution; null for a normal step. */
  applied: ScenarioKind | null;
}

/**
 * Default underpayment: ten percent of the payout, at least one fil, and always
 * strictly smaller than the payout so the settlement debit stays positive.
 */
export function defaultShortfallMinor(amountMinor: bigint): bigint {
  const tenth = amountMinor / 10n;
  const candidate = tenth < 1n ? 1n : tenth;
  return candidate >= amountMinor ? amountMinor - 1n : candidate;
}

export function assertShortfall(amountMinor: bigint, shortfallMinor: bigint): void {
  if (shortfallMinor <= 0n) {
    throw validationError("shortfall must be greater than zero");
  }
  if (shortfallMinor >= amountMinor) {
    throw validationError("shortfall must be smaller than the payout amount", {
      amount_minor: amountMinor.toString(),
      shortfall_minor: shortfallMinor.toString(),
    });
  }
}

/**
 * Apply one armed scenario to one requested transition.
 *
 * - `underpaid` bends settlement: the debit is `amount - shortfall`, the full hold
 *   is released, and the difference stays in the payer's available balance.
 * - `sanctions_hold` refuses `accepted` and `settled` with 423 and stays armed.
 * - `bank_timeout` refuses `submitted -> accepted` with 504 and stays armed, so a
 *   retry can still go through once the scenario is disarmed.
 * - `returned` redirects `submitted -> accepted` into `submitted -> returned`, which
 *   releases the hold without moving the ledger.
 */
export function resolveScenario(input: {
  kind: ScenarioKind;
  from: PayoutStatus;
  to: PayoutStatus;
  amountMinor: bigint;
  shortfallMinor: bigint | null;
}): ScenarioResolution {
  const unchanged: ScenarioResolution = {
    to: input.to,
    settleMinor: input.to === "settled" ? input.amountMinor : null,
    block: null,
    consumes: false,
    applied: null,
  };

  switch (input.kind) {
    case "sanctions_hold": {
      if (input.to !== "accepted" && input.to !== "settled") return unchanged;
      return {
        ...unchanged,
        block: {
          code: "payment_held",
          message: "the payout is held for sanctions review and cannot advance",
          statusCode: 423,
          details: { scenario: "sanctions_hold", from: input.from, to: input.to },
        },
      };
    }
    case "bank_timeout": {
      if (input.from !== "submitted" || input.to !== "accepted") return unchanged;
      return {
        ...unchanged,
        block: {
          code: "rail_timeout",
          message: "the simulated rail did not answer; the payout is still submitted",
          statusCode: 504,
          details: { scenario: "bank_timeout", from: input.from, to: input.to },
        },
      };
    }
    case "returned": {
      if (input.from !== "submitted" || input.to !== "accepted") return unchanged;
      return {
        to: "returned",
        settleMinor: null,
        block: null,
        consumes: true,
        applied: "returned",
      };
    }
    case "underpaid": {
      if (input.to !== "settled") return unchanged;
      if (input.amountMinor <= 1n) {
        throw validationError("the payout is too small to simulate an underpayment");
      }
      const shortfall = input.shortfallMinor ?? defaultShortfallMinor(input.amountMinor);
      assertShortfall(input.amountMinor, shortfall);
      return {
        to: "settled",
        settleMinor: input.amountMinor - shortfall,
        block: null,
        consumes: true,
        applied: "underpaid",
      };
    }
  }
}
