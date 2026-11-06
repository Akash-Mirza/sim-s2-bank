import { describe, expect, it } from "vitest";
import {
  cutoffInstant,
  dubaiMoment,
  isBusinessDay,
  nextBusinessDay,
  settlementDate,
} from "../../src/domain/calendar.js";

describe("UAE business calendar", () => {
  it("reads the wall clock in Asia/Dubai", () => {
    expect(dubaiMoment(new Date("2026-11-05T10:41:00Z"))).toEqual({
      date: "2026-11-05",
      hour: 14,
      minute: 41,
    });
    expect(dubaiMoment(new Date("2026-11-05T20:30:00Z")).date).toBe("2026-11-06");
  });

  it("treats Friday as a business day and the weekend as closed", () => {
    expect(isBusinessDay("2026-11-05")).toBe(true); // Thursday
    expect(isBusinessDay("2026-11-06")).toBe(true); // Friday
    expect(isBusinessDay("2026-11-07")).toBe(false); // Saturday
    expect(isBusinessDay("2026-11-08")).toBe(false); // Sunday
    expect(isBusinessDay("2026-12-02")).toBe(false); // National Day
  });

  it("rolls to the next business day across a weekend or holiday", () => {
    expect(nextBusinessDay("2026-11-05")).toBe("2026-11-06");
    expect(nextBusinessDay("2026-11-06")).toBe("2026-11-09");
    expect(nextBusinessDay("2026-12-01")).toBe("2026-12-04");
  });

  it("settles today before the cut-off and tomorrow after it", () => {
    expect(settlementDate(new Date("2026-11-05T10:00:00Z"))).toEqual({
      scheduledFor: "2026-11-05",
      cutoffAt: cutoffInstant("2026-11-05"),
      afterCutoff: false,
    });

    expect(settlementDate(new Date("2026-11-05T12:30:00Z")).scheduledFor).toBe("2026-11-06");
    expect(settlementDate(new Date("2026-11-06T12:30:00Z")).scheduledFor).toBe("2026-11-09");
  });

  it("rejects a value date in the past or on a non-business day", () => {
    const now = new Date("2026-11-05T10:00:00Z");
    expect(() => settlementDate(now, "2026-11-04")).toThrow(/past/);
    expect(() => settlementDate(now, "2026-11-07")).toThrow(/business day/);
    expect(() => settlementDate(now, "2026-11-05T10:00:00Z")).toThrow(/ISO date/);
  });

  it("rejects same-day settlement after 15:00 GST", () => {
    const afterCutoff = new Date("2026-11-05T12:00:00Z");
    expect(() => settlementDate(afterCutoff, "2026-11-05")).toThrow(/cut-off/);
    expect(settlementDate(afterCutoff).scheduledFor).toBe("2026-11-06");
  });
});
