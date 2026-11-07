import { describe, expect, it } from "vitest";
import { adjustableClock, businessDate } from "../../src/config/clock.js";

describe("adjustable clock", () => {
  it("follows the system clock when not frozen", () => {
    const clock = adjustableClock();
    const before = Date.now();
    const now = clock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
    expect(clock.isFrozen()).toBe(false);
  });

  it("starts frozen from SIM_CLOCK and steps forward", () => {
    const clock = adjustableClock("2026-11-05T10:41:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-11-05T10:41:00.000Z");
    expect(clock.isFrozen()).toBe(true);

    clock.step(15 * 60_000);
    expect(clock.now().toISOString()).toBe("2026-11-05T10:56:00.000Z");

    clock.step(24 * 60 * 60_000);
    expect(businessDate(clock.now())).toBe("2026-11-06");
  });

  it("freezes at an explicit instant and resumes the system clock", () => {
    const clock = adjustableClock();
    clock.freeze("2026-11-05T12:00:00.000+04:00");
    expect(clock.now().toISOString()).toBe("2026-11-05T08:00:00.000Z");
    expect(clock.state()).toMatchObject({
      frozen: true,
      base: "2026-11-05T08:00:00.000Z",
      now: "2026-11-05T08:00:00.000Z",
    });

    clock.resume();
    expect(clock.isFrozen()).toBe(false);
    expect(clock.state().base).toBeNull();
  });

  it("refuses a non-positive step", () => {
    const clock = adjustableClock("2026-11-05T10:41:00.000Z");
    expect(() => clock.step(0)).toThrow(/positive/);
    expect(() => clock.step(-1)).toThrow(/positive/);
  });

  it("reads the business date in Asia/Dubai", () => {
    expect(businessDate(new Date("2026-11-05T20:30:00.000Z"))).toBe("2026-11-06");
  });
});
