export type ErrorCode =
  | "validation_error"
  | "unauthorized"
  | "not_found"
  | "account_restricted"
  | "insufficient_funds"
  | "invalid_iban"
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

export function notFound(message: string): DomainError {
  return new DomainError("not_found", message, 404);
}

export function insufficientFunds(availableMinor: bigint, requestedMinor: bigint): DomainError {
  return new DomainError("insufficient_funds", "available balance is too low", 422, {
    available_minor: availableMinor.toString(),
    requested_minor: requestedMinor.toString(),
  });
}
