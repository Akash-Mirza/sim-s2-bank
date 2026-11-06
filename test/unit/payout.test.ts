import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import {
  allowedTransitions,
  assertPayoutTransition,
  nextPayoutStatus,
} from "../../src/domain/payout.js";

describe("payout state machine", () => {
  it("walks the happy path to settled", () => {
    expect(() => assertPayoutTransition("created", "validated")).not.toThrow();
    expect(() => assertPayoutTransition("validated", "submitted")).not.toThrow();
    expect(() => assertPayoutTransition("submitted", "accepted")).not.toThrow();
    expect(() => assertPayoutTransition("accepted", "settled")).not.toThrow();
  });

  it("refuses to skip steps", () => {
    expect(() => assertPayoutTransition("created", "settled")).toThrow(DomainError);
    expect(() => assertPayoutTransition("created", "submitted")).toThrow(
      /illegal state transition/,
    );
  });

  it("refuses to leave a terminal state", () => {
    expect(() => assertPayoutTransition("cancelled", "submitted")).toThrow();
    expect(() => assertPayoutTransition("failed", "settled")).toThrow();
    expect(allowedTransitions("failed")).toEqual([]);
  });

  it("allows returns from accepted and from settled", () => {
    expect(() => assertPayoutTransition("accepted", "returned")).not.toThrow();
    expect(() => assertPayoutTransition("settled", "returned")).not.toThrow();
  });

  it("reports the next status and stops at terminal states", () => {
    expect(nextPayoutStatus("created")).toBe("validated");
    expect(nextPayoutStatus("accepted")).toBe("settled");
    expect(nextPayoutStatus("settled")).toBeNull();
    expect(nextPayoutStatus("cancelled")).toBeNull();
  });
});
