import { describe, expect, it } from "vitest";
import {
  type BalanceSnapshot,
  applyLedgerMovement,
  availableMinor,
} from "../../src/domain/balance.js";
import { DomainError } from "../../src/domain/errors.js";

const zero: BalanceSnapshot = { ledgerMinor: 0n, pendingMinor: 0n, heldMinor: 0n };

describe("balance rules", () => {
  it("available = book - held - pending", () => {
    expect(
      availableMinor({ ledgerMinor: 100_000n, pendingMinor: 10_000n, heldMinor: 5_000n }),
    ).toBe(85_000n);
  });

  it("a credit raises the book balance", () => {
    expect(applyLedgerMovement(zero, "C", 125_000n)).toEqual({
      ledgerMinor: 125_000n,
      pendingMinor: 0n,
      heldMinor: 0n,
    });
  });

  it("a debit lowers the book balance and keeps held funds untouched", () => {
    const next = applyLedgerMovement(
      { ledgerMinor: 200_000n, pendingMinor: 0n, heldMinor: 50_000n },
      "D",
      100_000n,
    );
    expect(next.ledgerMinor).toBe(100_000n);
    expect(next.heldMinor).toBe(50_000n);
  });

  it("a debit cannot take available below zero", () => {
    expect(() => applyLedgerMovement(zero, "D", 1n)).toThrow(DomainError);
    expect(() =>
      applyLedgerMovement(
        { ledgerMinor: 100_000n, pendingMinor: 0n, heldMinor: 100_000n },
        "D",
        1n,
      ),
    ).toThrow(DomainError);
  });
});
