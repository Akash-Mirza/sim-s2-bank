import { describe, expect, it } from "vitest";
import {
  SCENARIO_KINDS,
  assertShortfall,
  defaultShortfallMinor,
  resolveScenario,
} from "../../src/domain/scenario.js";

describe("scenario catalogue", () => {
  it("declares the four faults the packet promises", () => {
    expect(SCENARIO_KINDS).toEqual(["underpaid", "sanctions_hold", "bank_timeout", "returned"]);
  });
});

describe("default shortfall", () => {
  it("takes ten percent, at least one fil, always below the amount", () => {
    expect(defaultShortfallMinor(100_000n)).toBe(10_000n);
    expect(defaultShortfallMinor(1_000n)).toBe(100n);
    expect(defaultShortfallMinor(5n)).toBe(1n);
    expect(defaultShortfallMinor(2n)).toBe(1n);
    expect(defaultShortfallMinor(1n)).toBe(0n);
  });

  it("rejects a shortfall that is zero or the whole payout", () => {
    expect(() => assertShortfall(1_000n, 0n)).toThrow(/greater than zero/);
    expect(() => assertShortfall(1_000n, 1_000n)).toThrow(/smaller than the payout/);
    expect(() => assertShortfall(1_000n, 1_200n)).toThrow(/smaller than the payout/);
    expect(() => assertShortfall(1_000n, 999n)).not.toThrow();
  });
});

describe("underpaid", () => {
  it("settles for amount minus shortfall and is consumed", () => {
    const resolution = resolveScenario({
      kind: "underpaid",
      from: "accepted",
      to: "settled",
      amountMinor: 100_000n,
      shortfallMinor: 10_000n,
    });

    expect(resolution.to).toBe("settled");
    expect(resolution.settleMinor).toBe(90_000n);
    expect(resolution.consumes).toBe(true);
    expect(resolution.applied).toBe("underpaid");
    expect(resolution.block).toBeNull();
  });

  it("uses the default shortfall when none was armed", () => {
    const resolution = resolveScenario({
      kind: "underpaid",
      from: "accepted",
      to: "settled",
      amountMinor: 50_000n,
      shortfallMinor: null,
    });
    expect(resolution.settleMinor).toBe(45_000n);
  });

  it("leaves every other transition alone", () => {
    for (const [from, to] of [
      ["created", "validated"],
      ["validated", "submitted"],
      ["submitted", "accepted"],
    ] as const) {
      const resolution = resolveScenario({
        kind: "underpaid",
        from,
        to,
        amountMinor: 50_000n,
        shortfallMinor: 5_000n,
      });
      expect(resolution.to).toBe(to);
      expect(resolution.consumes).toBe(false);
      expect(resolution.settleMinor).toBeNull();
    }
  });
});

describe("sanctions hold", () => {
  it("refuses accept and settle with 423 and stays armed", () => {
    for (const [from, to] of [
      ["submitted", "accepted"],
      ["accepted", "settled"],
    ] as const) {
      const resolution = resolveScenario({
        kind: "sanctions_hold",
        from,
        to,
        amountMinor: 10_000n,
        shortfallMinor: null,
      });
      expect(resolution.block?.code).toBe("payment_held");
      expect(resolution.block?.statusCode).toBe(423);
      expect(resolution.consumes).toBe(false);
      expect(resolution.to).toBe(to);
    }
  });

  it("does not block the steps before submit", () => {
    const resolution = resolveScenario({
      kind: "sanctions_hold",
      from: "created",
      to: "validated",
      amountMinor: 10_000n,
      shortfallMinor: null,
    });
    expect(resolution.block).toBeNull();
  });
});

describe("bank timeout", () => {
  it("refuses submitted -> accepted with 504 and leaves the payout submitted", () => {
    const resolution = resolveScenario({
      kind: "bank_timeout",
      from: "submitted",
      to: "accepted",
      amountMinor: 10_000n,
      shortfallMinor: null,
    });
    expect(resolution.block?.code).toBe("rail_timeout");
    expect(resolution.block?.statusCode).toBe(504);
    expect(resolution.to).toBe("accepted");
    expect(resolution.consumes).toBe(false);
  });

  it("does not fire on settlement", () => {
    const resolution = resolveScenario({
      kind: "bank_timeout",
      from: "accepted",
      to: "settled",
      amountMinor: 10_000n,
      shortfallMinor: null,
    });
    expect(resolution.block).toBeNull();
    expect(resolution.settleMinor).toBe(10_000n);
  });
});

describe("returned", () => {
  it("redirects accept into returned and is consumed", () => {
    const resolution = resolveScenario({
      kind: "returned",
      from: "submitted",
      to: "accepted",
      amountMinor: 10_000n,
      shortfallMinor: null,
    });
    expect(resolution.to).toBe("returned");
    expect(resolution.settleMinor).toBeNull();
    expect(resolution.consumes).toBe(true);
    expect(resolution.applied).toBe("returned");
  });

  it("does nothing outside submit", () => {
    const resolution = resolveScenario({
      kind: "returned",
      from: "accepted",
      to: "settled",
      amountMinor: 10_000n,
      shortfallMinor: null,
    });
    expect(resolution.to).toBe("settled");
    expect(resolution.consumes).toBe(false);
  });
});
