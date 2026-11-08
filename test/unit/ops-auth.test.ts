import { describe, expect, it } from "vitest";
import {
  MIN_PASSWORD_LENGTH,
  assertPasswordPolicy,
  hashPassword,
  verifyPassword,
} from "../../src/adapters/crypto/passwords.js";
import { hashSessionSecret, parseOpsToken } from "../../src/application/ops-sessions.js";

describe("ops password hashing", () => {
  it("hashes with a random salt and verifies the password", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(stored).not.toContain("correct horse");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(verifyPassword("correct horse battery stapl", stored)).toBe(false);
  });

  it("uses a different salt for the same password", () => {
    expect(hashPassword("same-password-1234")).not.toBe(hashPassword("same-password-1234"));
  });

  it("returns false for a malformed or foreign hash instead of throwing", () => {
    for (const stored of [
      "",
      "nope",
      "scrypt$1$2",
      "bcrypt$16384$8$1$aa$bb",
      "scrypt$16384$8$1$$",
    ]) {
      expect(verifyPassword("anything", stored)).toBe(false);
    }
  });

  it("enforces a minimum length policy", () => {
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(12);
    expect(() => assertPasswordPolicy("short")).toThrow(/at least/);
    expect(() => assertPasswordPolicy("long-enough-password")).not.toThrow();
    expect(() => hashPassword("short")).toThrow(/at least/);
  });
});

describe("ops session tokens", () => {
  it("parses ops_<prefix>_<secret> and rejects anything else", () => {
    const secret = "a".repeat(43);
    expect(parseOpsToken(`ops_0123abcd_${secret}`)).toEqual({ prefix: "0123abcd", secret });

    for (const token of [
      "",
      "ops_",
      `ops_0123ABCD_${secret}`,
      `ops_0123abcd_${"a".repeat(10)}`,
      `sk_sim_0123abcd_${secret}`,
      `ops_0123abcd_${secret} extra`,
    ]) {
      expect(parseOpsToken(token)).toBeNull();
    }
  });

  it("hashes the secret with the pepper", () => {
    const secret = "a".repeat(43);
    const one = hashSessionSecret(secret, "pepper-one-0123456789");
    const two = hashSessionSecret(secret, "pepper-two-0123456789");

    expect(one).toHaveLength(64);
    expect(one).not.toBe(two);
    expect(one).toBe(hashSessionSecret(secret, "pepper-one-0123456789"));
    expect(one).not.toBe(hashSessionSecret(`${secret}b`, "pepper-one-0123456789"));
  });
});
