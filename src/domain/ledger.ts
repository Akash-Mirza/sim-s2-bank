import { DomainError } from "./errors.js";

export const LEDGER_ACCOUNTS = [
  "customer_deposit",
  "uaefts_clearing",
  "aani_clearing",
  "fee_income",
  "suspense",
] as const;

export type LedgerAccount = (typeof LEDGER_ACCOUNTS)[number];
export type Direction = "D" | "C";

export interface LedgerLine {
  ledgerAccount: LedgerAccount;
  direction: Direction;
  amountMinor: bigint;
}

export function sumByDirection(lines: readonly LedgerLine[], direction: Direction): bigint {
  return lines
    .filter((line) => line.direction === direction)
    .reduce((total, line) => total + line.amountMinor, 0n);
}

/** Every money movement is a balanced pair: sum(debits) === sum(credits). */
export function assertBalanced(lines: readonly LedgerLine[]): void {
  if (lines.length < 2) {
    throw new DomainError("validation_error", "a transaction needs at least two ledger lines", 400);
  }
  for (const line of lines) {
    if (line.amountMinor <= 0n) {
      throw new DomainError("validation_error", "ledger line amount must be positive", 400);
    }
  }

  const debits = sumByDirection(lines, "D");
  const credits = sumByDirection(lines, "C");
  if (debits !== credits) {
    throw new DomainError("validation_error", "transaction is not balanced", 400, {
      debits_minor: debits.toString(),
      credits_minor: credits.toString(),
    });
  }
}

/** Money in: UAE clearings are debited, the customer deposit account is credited. */
export function creditLines(amountMinor: bigint): LedgerLine[] {
  return [
    { ledgerAccount: "uaefts_clearing", direction: "D", amountMinor },
    { ledgerAccount: "customer_deposit", direction: "C", amountMinor },
  ];
}

/** Money out: the customer deposit account is debited, UAE clearings are credited. */
export function debitLines(amountMinor: bigint): LedgerLine[] {
  return [
    { ledgerAccount: "customer_deposit", direction: "D", amountMinor },
    { ledgerAccount: "uaefts_clearing", direction: "C", amountMinor },
  ];
}
