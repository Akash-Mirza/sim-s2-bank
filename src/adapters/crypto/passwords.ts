import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** scrypt cost parameters. N=16384 keeps a login under ~100ms on a demo host. */
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;

export const MIN_PASSWORD_LENGTH = 12;

/** Stored format: scrypt$N$r$p$saltHex$hashHex */
export function hashPassword(password: string): string {
  assertPasswordPolicy(password);
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(password, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/**
 * Constant-time verification. A malformed stored hash returns false rather than
 * throwing: a corrupted row must not turn into a 500 on the login route.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltHex = parts[4] ?? "";
  const hashHex = parts[5] ?? "";
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  if (saltHex === "" || hashHex === "" || hashHex.length % 2 !== 0) return false;

  const expected = Buffer.from(hashHex, "hex");
  if (expected.length === 0) return false;

  const derived = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length, {
    N: n,
    r,
    p,
  });
  return timingSafeEqual(derived, expected);
}

export function assertPasswordPolicy(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > 256) {
    throw new Error("password must be at most 256 characters");
  }
}
