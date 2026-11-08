export type ErrorCode =
  | "validation_error"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "account_restricted"
  | "insufficient_funds"
  | "invalid_iban"
  | "invalid_bic"
  | "cutoff_passed"
  | "invalid_state_transition"
  | "amount_out_of_range"
  | "idempotency_conflict"
  | "payment_held"
  | "rail_timeout"
  | "scenario_conflict"
  | "internal_error";

/** A rule the domain refused, carrying the HTTP mapping for the edge. */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, statusCode: number, details?: unknown) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function validationError(message: string, details?: unknown): DomainError {
  return new DomainError("validation_error", message, 400, details);
}

export function forbidden(message: string): DomainError {
  return new DomainError("forbidden", message, 403);
}

export function notFound(message: string): DomainError {
  return new DomainError("not_found", message, 404);
}

export function idempotencyConflict(message: string): DomainError {
  return new DomainError("idempotency_conflict", message, 409);
}

export function invalidIban(message: string, details?: unknown): DomainError {
  return new DomainError("invalid_iban", message, 422, details);
}

export function invalidBic(message: string): DomainError {
  return new DomainError("invalid_bic", message, 422);
}

export function cutoffPassed(message: string, details?: unknown): DomainError {
  return new DomainError("cutoff_passed", message, 422, details);
}

export function amountOutOfRange(message: string, details?: unknown): DomainError {
  return new DomainError("amount_out_of_range", message, 422, details);
}

export function invalidStateTransition(
  from: string,
  to: string,
  allowed: readonly string[],
): DomainError {
  return new DomainError(
    "invalid_state_transition",
    `illegal state transition from ${from} to ${to}`,
    409,
    { from, to, allowed },
  );
}

export function insufficientFunds(availableMinor: bigint, requestedMinor: bigint): DomainError {
  return new DomainError("insufficient_funds", "available balance is too low", 422, {
    available_minor: availableMinor.toString(),
    requested_minor: requestedMinor.toString(),
  });
}
