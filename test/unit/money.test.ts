import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import { formatAmountMinor, parseAmountMinor } from "../../src/domain/money.js";

describe("parseAmountMinor", () => {
  it("parses whole and fractional AED into fils", () => {
    expect(parseAmountMinor("1250.00")).toBe(125_000n);
    expect(parseAmountMinor("1250.5")).toBe(125_050n);
    expect(parseAmountMinor("0.01")).toBe(1n);
    expect(parseAmountMinor("999999999999.99")).toBe(99_999_999_999_999n);
  });

  it("rejects zero, negatives, extra decimals, and exponents", () => {
    for (const input of ["0", "0.00", "-1.00", "1.001", "1e3", "abc", "", "1,000.00", " 1.00 "]) {
      if (input === " 1.00 ") continue; // trimmed intentionally
      expect(() => parseAmountMinor(input)).toThrow(DomainError);
    }
  });

  it("trims surrounding whitespace", () => {
    expect(parseAmountMinor(" 1.00 ")).toBe(100n);
  });
});

describe("formatAmountMinor", () => {
  it("round-trips two-decimal AED strings", () => {
    for (const input of ["0.01", "1.00", "1250.00", "1250.50", "999999999999.99"]) {
      expect(formatAmountMinor(parseAmountMinor(input))).toBe(input);
    }
  });

  it("formats negative values without losing the fraction", () => {
    expect(formatAmountMinor(-5n)).toBe("-0.05");
    expect(formatAmountMinor(-125_000n)).toBe("-1250.00");
  });
});
