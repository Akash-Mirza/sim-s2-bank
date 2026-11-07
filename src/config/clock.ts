export interface Clock {
  now(): Date;
}

export interface ClockState {
  frozen: boolean;
  /** The instant the clock was frozen at, or null when it follows the system clock. */
  base: string | null;
  /** What `now()` currently returns. */
  now: string;
}

/** A clock the ops surface can freeze and step without restarting the process. */
export interface AdjustableClock extends Clock {
  freeze(at?: string | Date): Date;
  step(milliseconds: number): Date;
  resume(): void;
  isFrozen(): boolean;
  state(): ClockState;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Frozen clock for deterministic demos and tests. It cannot be stepped. */
export function fixedClock(iso: string | undefined): Clock {
  if (iso === undefined) return systemClock;
  const fixed = new Date(iso);
  if (Number.isNaN(fixed.getTime())) {
    throw new Error(`invalid SIM_CLOCK value: ${iso}`);
  }
  return { now: () => new Date(fixed.getTime()) };
}

function parseInstant(value: string | Date, label: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid ${label}: ${String(value)}`);
  }
  return date;
}

class SimulatorClock implements AdjustableClock {
  private base: Date | null;
  private offsetMs = 0;

  constructor(initialIso?: string) {
    if (initialIso === undefined || initialIso === "") {
      this.base = null;
    } else {
      this.base = parseInstant(initialIso, "SIM_CLOCK");
    }
  }

  now(): Date {
    if (this.base === null) return new Date();
    return new Date(this.base.getTime() + this.offsetMs);
  }

  freeze(at?: string | Date): Date {
    this.base = at === undefined ? new Date() : parseInstant(at, "clock freeze instant");
    this.offsetMs = 0;
    return this.now();
  }

  step(milliseconds: number): Date {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
      throw new Error("clock step must be a positive number of milliseconds");
    }
    if (this.base === null) this.base = new Date();
    this.offsetMs += milliseconds;
    return this.now();
  }

  resume(): void {
    this.base = null;
    this.offsetMs = 0;
  }

  isFrozen(): boolean {
    return this.base !== null;
  }

  state(): ClockState {
    return {
      frozen: this.isFrozen(),
      base: this.base === null ? null : this.base.toISOString(),
      now: this.now().toISOString(),
    };
  }
}

/**
 * The server clock. With SIM_CLOCK set it starts frozen at that instant; ops can
 * freeze or step it later through `/ops/v1/clock`.
 */
export function adjustableClock(initialIso?: string): AdjustableClock {
  return new SimulatorClock(initialIso);
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
