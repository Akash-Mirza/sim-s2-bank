export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Frozen clock for deterministic demos and tests. */
export function fixedClock(iso: string | undefined): Clock {
  if (iso === undefined) return systemClock;
  const fixed = new Date(iso);
  if (Number.isNaN(fixed.getTime())) {
    throw new Error(`invalid SIM_CLOCK value: ${iso}`);
  }
  return { now: () => new Date(fixed.getTime()) };
}

const DUBAI_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Dubai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Business date in the simulator's time zone (Asia/Dubai). */
export function businessDate(now: Date): string {
  return DUBAI_DATE.format(now);
}
