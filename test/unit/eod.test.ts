import { describe, expect, it } from "vitest";
import { assertEodCloseable, buildEodSnapshot, nextEodDate } from "../../src/domain/eod.js";
import { DomainError } from "../../src/domain/errors.js";
import { type Statement, buildStatement } from "../../src/domain/statement.js";

function dailyStatement(date = "2026-11-05"): Statement {
  return buildStatement({
    accountId: "11111111-1111-4111-8111-111111111111",
    iban: "AE819990123456789012345",
    currency: "AED",
    from: date,
    to: date,
    openingMinor: 100_000n,
    lines: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        type: "credit_transfer",
        status: "posted",
        valueDate: date,
        bookingDate: date,
        amountMinor: 25_000n,
        currency: "AED",
        direction: "credit",
        reference: "DEP-1",
        endToEndId: null,
        remitter: "GULF TRADING LLC",
        balanceAfterMinor: 125_000n,
      },
    ],
  });
}

describe("EOD domain", () => {
  it("accepts a first close on any business day up to today", () => {
    expect(() =>
      assertEodCloseable({ businessDate: "2026-11-05", lastClosed: null, today: "2026-11-07" }),
    ).not.toThrow();
  });

  it("refuses a non-business day and a future date", () => {
    expect(() =>
      assertEodCloseable({ businessDate: "2026-11-07", lastClosed: null, today: "2026-11-07" }),
    ).toThrow(/UAE business day/);
    expect(() =>
      assertEodCloseable({ businessDate: "2026-11-09", lastClosed: null, today: "2026-11-07" }),
    ).toThrow(/future/);
  });

  it("closes sequentially and skips the weekend", () => {
    expect(() =>
      assertEodCloseable({ businessDate: "2026-11-06", lastClosed: null, today: "2026-11-09" }),
    ).not.toThrow();
    expect(() =>
      assertEodCloseable({
        businessDate: "2026-11-06",
        lastClosed: "2026-11-05",
        today: "2026-11-09",
      }),
    ).not.toThrow();
    expect(() =>
      assertEodCloseable({
        businessDate: "2026-11-09",
        lastClosed: "2026-11-06",
        today: "2026-11-09",
      }),
    ).not.toThrow();
  });

  it("refuses a repeat, an earlier day, and a skipped business day", () => {
    for (const date of ["2026-11-05", "2026-11-04", "2026-11-09"]) {
      let caught: unknown;
      try {
        assertEodCloseable({
          businessDate: date,
          lastClosed: "2026-11-05",
          today: "2026-11-10",
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe("invalid_state_transition");
      expect((caught as DomainError).statusCode).toBe(409);
    }
  });

  it("computes the next business day, not the next calendar day", () => {
    expect(nextEodDate("2026-11-05")).toBe("2026-11-06");
    expect(nextEodDate("2026-11-06")).toBe("2026-11-09");
  });

  it("builds a snapshot whose balance identity holds", () => {
    const snapshot = buildEodSnapshot(dailyStatement());
    expect(snapshot).toMatchObject({
      businessDate: "2026-11-05",
      openingMinor: 100_000n,
      closingMinor: 125_000n,
      creditsMinor: 25_000n,
      debitsMinor: 0n,
      lineCount: 1,
    });
    expect(snapshot.checksum).toHaveLength(64);
  });
});
