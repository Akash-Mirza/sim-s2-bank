export const BIC = "SIMSAEXXXX";
export const BANK_CODE = "033";
export const CURRENCY = "AED";
export const MODE = "sim";

export const TRANSACTION_TYPES = [
  "credit_transfer",
  "payout",
  "fee",
  "reversal",
  "hold_capture",
  "interest",
] as const;

export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const ACCOUNT_STATUSES = ["open", "restricted", "closed"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
