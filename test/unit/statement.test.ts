import { describe, expect, it } from "vitest";
import {
  type Statement,
  type StatementLine,
  buildStatement,
  renderStatementCsv,
  renderStatementJson,
  renderStatementMt940,
  statementChecksum,
  validateStatementRange,
} from "../../src/domain/statement.js";

function line(overrides: Partial<StatementLine> = {}): StatementLine {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    type: "credit_transfer",
    status: "posted",
    valueDate: "2026-11-05",
    bookingDate: "2026-11-05",
    amountMinor: 125_000n,
    currency: "AED",
    direction: "credit",
    reference: "DEP-2026-000123",
    endToEndId: null,
    remitter: "GULF TRADING LLC",
    balanceAfterMinor: 1_337_500n,
    ...overrides,
  };
}

function statement(): Statement {
  return buildStatement({
    accountId: "11111111-1111-4111-8111-111111111111",
    iban: "AE819990123456789012345",
    currency: "AED",
    from: "2026-11-05",
    to: "2026-11-05",
    openingMinor: 1_212_500n,
    lines: [
      line({ balanceAfterMinor: 1_337_500n }),
      line({
        id: "00000000-0000-4000-8000-000000000002",
        type: "payout",
        direction: "debit",
        amountMinor: 40_000n,
        reference: "INV-2026-0042",
        remitter: null,
        balanceAfterMinor: 1_297_500n,
      }),
    ],
  });
}

describe("statement domain", () => {
  it("computes opening, closing, credits and debits from the ledger lines", () => {
    const result = statement();
    expect(result.openingMinor).toBe(1_212_500n);
    expect(result.creditsMinor).toBe(125_000n);
    expect(result.debitsMinor).toBe(40_000n);
    expect(result.closingMinor).toBe(1_297_500n);
  });

  it("derives balance-after in booking order even when the stored value lags", () => {
    const result = buildStatement({
      accountId: "11111111-1111-4111-8111-111111111111",
      iban: "AE819990123456789012345",
      currency: "AED",
      from: "2026-11-05",
      to: "2026-11-05",
      openingMinor: 1_212_500n,
      lines: [line({ balanceAfterMinor: 9_999_999n })],
    });
    expect(result.closingMinor).toBe(1_337_500n);
    expect(result.lines[0]?.balanceAfterMinor).toBe(1_337_500n);
  });

  it("bounds the range and rejects a reversed range", () => {
    expect(() => validateStatementRange("2026-11-05", "2026-11-01")).toThrow(/on or before/);
    expect(() => validateStatementRange("2025-01-01", "2026-11-01")).toThrow(/366 days/);
    expect(() => validateStatementRange("2026-13-01", "2026-11-01")).toThrow(/ISO date/);
  });

  it("renders JSON, CSV and MT940 from one model with the same balances", () => {
    const value = statement();
    const json = renderStatementJson(value);
    const csv = renderStatementCsv(value);
    const mt940 = renderStatementMt940(value);

    expect(json.opening_balance).toBe("12125.00");
    expect(json.closing_balance).toBe("12975.00");
    expect(json.totals).toEqual({ credits: "1250.00", debits: "400.00", count: 2 });
    expect(json.lines[0]?.remitter).toBe("GULF TRADING LLC");

    expect(csv.split("\n")[0]).toBe(
      "value_date,booking_date,amount,currency,direction,reference,remitter,status",
    );
    expect(csv).toContain("2026-11-05,2026-11-05,1250.00,AED,credit,DEP-2026-000123");

    expect(mt940).toContain(":20:SIM-11111111");
    expect(mt940).toContain(":25:AE819990123456789012345");
    expect(mt940).toContain(":60F:C261105AED12125,00");
    expect(mt940).toContain(":61:2611051105C1250,00NTRFDEP-2026-000123");
    expect(mt940).toContain(":61:2611051105D400,00NTRFINV-2026-0042");
    expect(mt940).toContain(":86:GULF TRADING LLC / DEP-2026-000123");
    expect(mt940).toContain(":62F:C261105AED12975,00");
    expect(JSON.stringify(json)).toContain('"closing_balance":"12975.00"');
  });

  it("escapes CSV cells containing commas and quotes", () => {
    const csv = renderStatementCsv(
      buildStatement({
        accountId: "11111111-1111-4111-8111-111111111111",
        iban: "AE819990123456789012345",
        currency: "AED",
        from: "2026-11-05",
        to: "2026-11-05",
        openingMinor: 0n,
        lines: [line({ reference: 'INV, "42"', balanceAfterMinor: 125_000n })],
      }),
    );
    expect(csv).toContain('"INV, ""42"""');
  });

  it("produces a stable checksum that changes with the lines", () => {
    const value = statement();
    expect(statementChecksum(value.lines)).toBe(statementChecksum(value.lines));
    expect(statementChecksum(value.lines)).not.toBe(statementChecksum(value.lines.slice(0, 1)));
  });
});
