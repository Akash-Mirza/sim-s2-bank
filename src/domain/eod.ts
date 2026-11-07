import { isBusinessDay, nextBusinessDay } from "./calendar.js";
import { invalidStateTransition, validationError } from "./errors.js";
import { type Statement, statementChecksum } from "./statement.js";

export interface EodSnapshot {
  businessDate: string;
  openingMinor: bigint;
  closingMinor: bigint;
  creditsMinor: bigint;
  debitsMinor: bigint;
  lineCount: number;
  checksum: string;
}

function notBusinessDay(date: string): Error {
  return validationError(`EOD can only close a UAE business day: ${date} is not one`, {
    business_date: date,
  });
}

/**
 * EOD is sequential per account: a day may be closed only once, and the next close
 * must be the next UAE business day. Weekends and holidays are skipped, never
 * silently compressed into the following close.
 */
export function assertEodCloseable(input: {
  businessDate: string;
  lastClosed: string | null;
  today: string;
}): void {
  if (!isBusinessDay(input.businessDate)) {
    throw notBusinessDay(input.businessDate);
  }
  if (input.businessDate > input.today) {
    throw validationError("cannot close a future business date", {
      business_date: input.businessDate,
      today: input.today,
    });
  }

  if (input.lastClosed === null) return;

  const expected = nextBusinessDay(input.lastClosed);
  if (input.businessDate === input.lastClosed || input.businessDate < input.lastClosed) {
    throw invalidStateTransition(input.lastClosed, input.businessDate, [expected]);
  }
  if (input.businessDate !== expected) {
    throw invalidStateTransition(input.lastClosed, input.businessDate, [expected]);
  }
}

/** The only legal next close after `lastClosed`, skipping the UAE weekend/holidays. */
export function nextEodDate(lastClosed: string): string {
  return nextBusinessDay(lastClosed);
}

/**
 * Turn a single-day statement into the immutable close snapshot. The balance identity
 * is checked again here because the snapshot is what later audits compare against.
 */
export function buildEodSnapshot(statement: Statement): EodSnapshot {
  if (statement.from !== statement.to) {
    throw validationError("an EOD snapshot covers exactly one business date", {
      from: statement.from,
      to: statement.to,
    });
  }
  const expectedClosing = statement.openingMinor + statement.creditsMinor - statement.debitsMinor;
  if (expectedClosing !== statement.closingMinor) {
    throw new Error("statement totals do not close");
  }

  return {
    businessDate: statement.from,
    openingMinor: statement.openingMinor,
    closingMinor: statement.closingMinor,
    creditsMinor: statement.creditsMinor,
    debitsMinor: statement.debitsMinor,
    lineCount: statement.lines.length,
    checksum: statementChecksum(statement.lines),
  };
}
