import { describe, expect, it } from "vitest";
import { canonicalJson, requestHash } from "../../src/http/idempotency.js";

describe("idempotency request hashing", () => {
  it("is stable regardless of object key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [1, 2] } })).toBe('{"a":{"c":[1,2],"d":2},"b":1}');
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("changes when the body, method, or route changes", () => {
    const base = requestHash("POST", "/v1/accounts/:id/credits:simulate", {
      amount: "1.00",
      reference: "DEP-1",
    });

    expect(
      requestHash("POST", "/v1/accounts/:id/credits:simulate", {
        amount: "1.01",
        reference: "DEP-1",
      }),
    ).not.toBe(base);
    expect(requestHash("PUT", "/v1/accounts/:id/credits:simulate", { amount: "1.00" })).not.toBe(
      base,
    );
    expect(requestHash("POST", "/v1/accounts/:id/holds", { amount: "1.00" })).not.toBe(base);
  });

  it("treats reordered keys as the same request", () => {
    const first = requestHash("POST", "/v1/accounts", { a: "1", b: "2" });
    const second = requestHash("POST", "/v1/accounts", { b: "2", a: "1" });
    expect(first).toBe(second);
  });
});
