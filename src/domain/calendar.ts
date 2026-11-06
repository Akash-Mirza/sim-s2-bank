import { DomainError, cutoffPassed, validationError } from "./errors.js";

const DUBAI_TIME_ZONE = "Asia/Dubai";
export const PAYOUT_CUTOFF_HOUR = 15;

const DUBAI_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: DUBAI_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface DubaiMoment {
  date: string;
  hour: number;
  minute: number;
}

/** Wall-clock moment in the simulator's time zone (Asia/Dubai, UTC+4, no DST). */
export function dubaiMoment(now: Date): DubaiMoment {
  const parts = DUBAI_PARTS.formatToParts(now);
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";

  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    hour: Number(value("hour")) % 24,
    minute: Number(value("minute")),
  };
}

/**
 * UAE public holidays used by the simulator. Islamic dates move each year, so
 * this is a demo set for 2026, not a regulatory calendar; replace it with the
 * CBUAE calendar feed when statements and EOD arrive (S2-07).
 */
const UAE_HOLIDAYS: ReadonlySet<string> = new Set([
  "2026-01-01", // New Year's Day
  "2026-03-20", // Eid al-Fitr (approximate)
  "2026-03-21",
  "2026-03-22",
  "2026-05-26", // Eid al-Adha (approximate)
  "2026-05-27",
  "2026-05-28",
  "2026-06-16", // Islamic New Year (approximate)
  "2026-08-25", // Prophet's birthday (approximate)
  "2026-12-01", // Commemoration Day
  "2026-12-02", // National Day
  "2026-12-03",
]);

function addDays(date: string, days: number): string {
  const moment = new Date(`${date}T12:00:00Z`);
  moment.setUTCDate(moment.getUTCDate() + days);
  return moment.toISOString().slice(0, 10);
}

export function isBusinessDay(date: string): boolean {
  if (!DATE_PATTERN.test(date)) return false;
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  // UAE weekend is Saturday and Sunday.
  return day !== 0 && day !== 6 && !UAE_HOLIDAYS.has(date);
}

export function nextBusinessDay(date: string): string {
  let candidate = addDays(date, 1);
  for (let step = 0; step < 14; step += 1) {
    if (isBusinessDay(candidate)) return candidate;
    candidate = addDays(candidate, 1);
  }
  throw new Error(`no business day within two weeks of ${date}`);
}

/** The cut-off instant for a settlement date, 15:00 Asia/Dubai. */
export function cutoffInstant(date: string): string {
  return new Date(
    `${date}T${String(PAYOUT_CUTOFF_HOUR).padStart(2, "0")}:00:00+04:00`,
  ).toISOString();
}

export interface SettlementDate {
  scheduledFor: string;
  cutoffAt: string;
  afterCutoff: boolean;
}

/**
 * Resolve the settlement date for a payout.
 *
 * Before 15:00 GST on a business day, today settles today; otherwise the payout
 * rolls to the next business day. An explicit value_date must be a business day,
 * not in the past, and if it is today it must be requested before the cut-off.
 */
export function settlementDate(now: Date, requested?: string): SettlementDate {
  const moment = dubaiMoment(now);
  const afterCutoff = moment.hour >= PAYOUT_CUTOFF_HOUR;

  if (requested !== undefined) {
    if (!DATE_PATTERN.test(requested) || Number.isNaN(Date.parse(`${requested}T12:00:00Z`))) {
      throw validationError("value_date must be an ISO date (YYYY-MM-DD)");
    }
    if (requested < moment.date) {
      throw validationError("value_date is in the past");
    }
    if (!isBusinessDay(requested)) {
      throw cutoffPassed("value_date is not a UAE business day", { value_date: requested });
    }
    if (requested === moment.date && afterCutoff) {
      throw cutoffPassed("the payout cut-off has passed for today", {
        cutoff: `${String(PAYOUT_CUTOFF_HOUR).padStart(2, "0")}:00 ${DUBAI_TIME_ZONE}`,
        scheduled_for: nextBusinessDay(moment.date),
      });
    }

    return {
      scheduledFor: requested,
      cutoffAt: cutoffInstant(requested),
      afterCutoff: requested === moment.date && afterCutoff,
    };
  }

  const scheduledFor =
    isBusinessDay(moment.date) && !afterCutoff ? moment.date : nextBusinessDay(moment.date);

  return { scheduledFor, cutoffAt: cutoffInstant(scheduledFor), afterCutoff };
}

/** Reject a payout whose value date is not a business day (defensive helper). */
export function assertBusinessDay(date: string): void {
  if (!isBusinessDay(date)) {
    throw new DomainError("cutoff_passed", "settlement date is not a UAE business day", 422, {
      value_date: date,
    });
  }
}
