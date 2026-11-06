import { DomainError } from "./errors.js";

export const AED = "AED";

const AMOUNT_PATTERN = /^(0|[1-9]\d{0,11})(?:\.(\d{1,2}))?$/;

/**
 * Parse a decimal AED string into fils. Money never becomes a float.
 * "1250.00" -> 125000n
 */
export function parseAmountMinor(input: string): bigint {
  if (typeof input !== "string") {
    throw new DomainError("validation_error", "amount must be a decimal string", 400);
  }
  const match = AMOUNT_PATTERN.exec(input.trim());
  if (match === null) {
    throw new DomainError(
      "validation_error",
      "amount must be a positive decimal with at most two fraction digits",
      400,
      { amount: input },
    );
  }

  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").padEnd(2, "0");
  const minor = BigInt(whole) * 100n + BigInt(fraction);

  if (minor <= 0n) {
    throw new DomainError("validation_error", "amount must be greater than zero", 400);
  }
  return minor;
}

/** Format fils back to the two-decimal AED string used in API payloads. */
export function formatAmountMinor(minor: bigint): string {
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
