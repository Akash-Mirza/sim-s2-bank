import { createHash } from "node:crypto";
import { DomainError, validationError } from "./errors.js";
import { formatAmountMinor } from "./money.js";

export const STATEMENT_FORMATS = ["json", "csv", "mt940"] as const;
export type StatementFormat = (typeof STATEMENT_FORMATS)[number];

export const MAX_STATEMENT_DAYS = 366;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type StatementDirection = "credit" | "debit";

export interface StatementLine {
  id: string;
  type: string;
  status: string;
  valueDate: string;
  bookingDate: string;
  amountMinor: bigint;
  currency: string;
  direction: StatementDirection;
  reference: string | null;
  endToEndId: string | null;
  remitter: string | null;
  /** Customer-account balance after this line, as stored by the ledger. */
  balanceAfterMinor: bigint | null;
}

export interface Statement {
  accountId: string;
  iban: string;
  currency: string;
  from: string;
  to: string;
  openingMinor: bigint;
  closingMinor: bigint;
  creditsMinor: bigint;
  debitsMinor: bigint;
  lines: StatementLine[];
}

export interface BuildStatementInput {
  accountId: string;
  iban: string;
  currency: string;
  from: string;
  to: string;
  openingMinor: bigint;
  lines: readonly StatementLine[];
}

function isIsoDate(value: string): boolean {
  return DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
}

function dayOrdinal(date: string): number {
  return Math.floor(Date.parse(`${date}T12:00:00Z`) / 86_400_000);
}

/** A statement range is inclusive and bounded so one request cannot scan the world. */
export function validateStatementRange(from: string, to: string): void {
  if (!isIsoDate(from)) {
    throw validationError("from must be an ISO date (YYYY-MM-DD)");
  }
  if (!isIsoDate(to)) {
    throw validationError("to must be an ISO date (YYYY-MM-DD)");
  }
  if (from > to) {
    throw validationError("from must be on or before to", { from, to });
  }
  const days = dayOrdinal(to) - dayOrdinal(from) + 1;
  if (days > MAX_STATEMENT_DAYS) {
    throw validationError(`statement range may not exceed ${MAX_STATEMENT_DAYS} days`, {
      days,
      max: MAX_STATEMENT_DAYS,
    });
  }
}

/**
 * Assemble a statement and prove it closes:
 * opening + credits - debits = closing. Balances are derived in booking-date order,
 * so a historical statement stays correct even if a later booking already exists.
 * The ledger-versus-cache check is a separate, always-valid integrity check in the
 * adapter; the stored `balance_after_minor` is advisory only.
 */
export function buildStatement(input: BuildStatementInput): Statement {
  validateStatementRange(input.from, input.to);
  if (input.openingMinor < 0n) {
    throw new DomainError("internal_error", "statement opening balance is negative", 500);
  }

  let creditsMinor = 0n;
  let debitsMinor = 0n;
  let running = input.openingMinor;
  let previousBookingDate = "";
  const lines: StatementLine[] = [];

  for (const line of input.lines) {
    if (line.bookingDate < input.from || line.bookingDate > input.to) {
      throw new DomainError(
        "internal_error",
        "statement line falls outside the requested range",
        500,
        {
          line_id: line.id,
          booking_date: line.bookingDate,
        },
      );
    }
    if (line.amountMinor <= 0n) {
      throw new DomainError("internal_error", "statement line amount must be positive", 500, {
        line_id: line.id,
      });
    }

    if (line.bookingDate < previousBookingDate) {
      throw new DomainError("internal_error", "statement lines are not ordered", 500, {
        line_id: line.id,
      });
    }
    previousBookingDate = line.bookingDate;

    if (line.direction === "credit") {
      creditsMinor += line.amountMinor;
      running += line.amountMinor;
    } else {
      debitsMinor += line.amountMinor;
      running -= line.amountMinor;
    }

    if (running < 0n) {
      throw new DomainError("internal_error", "statement balance went negative", 500, {
        line_id: line.id,
      });
    }

    // The statement's balance-after is the booking-date running balance, not the
    // posting-order value stored by the ledger.
    lines.push({ ...line, balanceAfterMinor: running });
  }

  return {
    accountId: input.accountId,
    iban: input.iban,
    currency: input.currency,
    from: input.from,
    to: input.to,
    openingMinor: input.openingMinor,
    closingMinor: running,
    creditsMinor,
    debitsMinor,
    lines,
  };
}

/** Stable digest of the statement lines; stored with an EOD snapshot for audit. */
export function statementChecksum(lines: readonly StatementLine[]): string {
  const canonical = lines
    .map(
      (line) =>
        `${line.id}:${line.direction}:${line.amountMinor.toString()}:${line.bookingDate}:${line.valueDate}`,
    )
    .join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

export interface StatementJsonLine {
  id: string;
  type: string;
  status: string;
  value_date: string;
  booking_date: string;
  amount: string;
  currency: string;
  direction: StatementDirection;
  reference: string | null;
  end_to_end_id: string | null;
  remitter: string | null;
  balance_after: string | null;
}

export interface StatementJson {
  mode: "sim";
  account: string;
  account_id: string;
  currency: string;
  from: string;
  to: string;
  opening_balance: string;
  closing_balance: string;
  totals: {
    credits: string;
    debits: string;
    count: number;
  };
  lines: StatementJsonLine[];
}

export function renderStatementJson(statement: Statement): StatementJson {
  return {
    mode: "sim",
    account: statement.iban,
    account_id: statement.accountId,
    currency: statement.currency,
    from: statement.from,
    to: statement.to,
    opening_balance: formatAmountMinor(statement.openingMinor),
    closing_balance: formatAmountMinor(statement.closingMinor),
    totals: {
      credits: formatAmountMinor(statement.creditsMinor),
      debits: formatAmountMinor(statement.debitsMinor),
      count: statement.lines.length,
    },
    lines: statement.lines.map((line) => ({
      id: line.id,
      type: line.type,
      status: line.status,
      value_date: line.valueDate,
      booking_date: line.bookingDate,
      amount: formatAmountMinor(line.amountMinor),
      currency: line.currency,
      direction: line.direction,
      reference: line.reference,
      end_to_end_id: line.endToEndId,
      remitter: line.remitter,
      balance_after:
        line.balanceAfterMinor === null ? null : formatAmountMinor(line.balanceAfterMinor),
    })),
  };
}

function csvCell(value: string | null): string {
  const text = value ?? "";
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** CSV is deliberately a flat, stable projection of the same statement model. */
export function renderStatementCsv(statement: Statement): string {
  const header = [
    "value_date",
    "booking_date",
    "amount",
    "currency",
    "direction",
    "reference",
    "remitter",
    "status",
  ];
  const rows = statement.lines.map((line) =>
    [
      line.valueDate,
      line.bookingDate,
      formatAmountMinor(line.amountMinor),
      line.currency,
      line.direction,
      csvCell(line.reference),
      csvCell(line.remitter),
      line.status,
    ].join(","),
  );
  return `${[header.join(","), ...rows].join("\n")}\n`;
}

function mt940Amount(minor: bigint): string {
  return formatAmountMinor(minor).replace(".", ",");
}

function mt940Date(date: string): string {
  return date.slice(2).replaceAll("-", "");
}

function mt940Text(value: string | null, fallback: string): string {
  const text = (value ?? fallback).replace(/[\r\n]+/g, " ").trim();
  return text.length === 0 ? fallback : text;
}

/**
 * SWIFT MT940 customer statement. This is the simulator's stable subfield layout,
 * documented in SPEC.md; real banks vary in `:61:`/`:86:` details.
 */
export function renderStatementMt940(statement: Statement): string {
  const sequence = `:20:SIM-${statement.accountId.replaceAll("-", "").slice(0, 8).toUpperCase()}`;
  const blocks = [
    sequence,
    `:25:${statement.iban}`,
    ":28C:00001/001",
    `:60F:C${mt940Date(statement.from)}${statement.currency}${mt940Amount(statement.openingMinor)}`,
  ];

  for (const line of statement.lines) {
    const sign = line.direction === "credit" ? "C" : "D";
    const reference = mt940Text(
      line.reference ?? line.endToEndId,
      line.id.replaceAll("-", "").slice(0, 16).toUpperCase(),
    )
      .replace(/\s+/g, "")
      .slice(0, 16);
    blocks.push(
      `:61:${mt940Date(line.valueDate)}${line.bookingDate.slice(5, 7)}${line.bookingDate.slice(
        8,
        10,
      )}${sign}${mt940Amount(line.amountMinor)}NTRF${reference}`,
    );
    blocks.push(
      `:86:${mt940Text(line.remitter, line.type)} / ${mt940Text(line.reference, reference)}`,
    );
  }

  blocks.push(
    `:62F:C${mt940Date(statement.to)}${statement.currency}${mt940Amount(statement.closingMinor)}`,
  );
  blocks.push("-");
  return `${blocks.join("\n")}\n`;
}
