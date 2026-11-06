import { describe, expect, it } from "vitest";
import {
  buildUaeIban,
  computeIbanCheckDigits,
  isUaeIban,
  isValidIban,
} from "../../src/domain/iban.js";

describe("UAE IBAN", () => {
  it("accepts a published UAE IBAN shape", () => {
    const iban = buildUaeIban("033", "1234567890123456");
    expect(iban).toMatch(/^AE\d{21}$/);
    expect(iban).toHaveLength(23);
    expect(isValidIban(iban)).toBe(true);
    expect(isUaeIban(iban)).toBe(true);
  });

  it("computes the check digits so the mod-97 remainder is 1", () => {
    const iban = buildUaeIban("033", "0000000000000001");
    expect(iban.slice(2, 4)).toBe(computeIbanCheckDigits("AE", "0330000000000000001"));
    expect(isValidIban(iban)).toBe(true);
  });

  it("rejects a mutated check digit and non-UAE lengths", () => {
    const iban = buildUaeIban("033", "1234567890123456");
    const mutated = `${iban.slice(0, 2)}${iban.slice(2, 4) === "00" ? "01" : "00"}${iban.slice(4)}`;
    expect(isValidIban(mutated)).toBe(false);
    expect(isUaeIban(`AE${"0".repeat(19)}`)).toBe(false);
    expect(isValidIban("GB82WEST12345698765432")).toBe(true);
    expect(isUaeIban("GB82WEST12345698765432")).toBe(false);
  });
});
