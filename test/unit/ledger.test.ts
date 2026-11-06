import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import {
  type LedgerLine,
  assertBalanced,
  creditLines,
  debitLines,
  sumByDirection,
} from "../../src/domain/ledger.js";

describe("double-entry rules", () => {
  it("credit pair debits clearings and credits the customer", () => {
    const lines = creditLines(125_000n);
    expect(() => assertBalanced(lines)).not.toThrow();
    expect(sumByDirection(lines, "D")).toBe(125_000n);
    expect(sumByDirection(lines, "C")).toBe(125_000n);
    expect(lines.find((line) => line.direction === "C")?.ledgerAccount).toBe("customer_deposit");
  });

  it("debit pair debits the customer and credits clearings", () => {
    const lines = debitLines(40_000n);
    expect(() => assertBalanced(lines)).not.toThrow();
    expect(lines.find((line) => line.direction === "D")?.ledgerAccount).toBe("customer_deposit");
  });

  it("rejects an unbalanced transaction", () => {
    const lines: LedgerLine[] = [
      { ledgerAccount: "customer_deposit", direction: "D", amountMinor: 100n },
      { ledgerAccount: "uaefts_clearing", direction: "C", amountMinor: 90n },
    ];
    expect(() => assertBalanced(lines)).toThrow(DomainError);
  });

  it("rejects a single-line or zero-amount transaction", () => {
    expect(() => assertBalanced([creditLines(100n)[0] as LedgerLine])).toThrow(DomainError);
    expect(() =>
      assertBalanced([
        { ledgerAccount: "customer_deposit", direction: "D", amountMinor: 0n },
        { ledgerAccount: "uaefts_clearing", direction: "C", amountMinor: 0n },
      ]),
    ).toThrow(DomainError);
  });
});
