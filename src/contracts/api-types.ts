// GENERATED FILE - do not edit.
// Source: src/contracts/spec.ts. Regenerate with `pnpm openapi`.
// The contract test fails when this file and the spec disagree.

export interface Error {
  error: {
  code: string;
  message: string;
  request_id: string;
  details: Record<string, unknown> | null;
};
}

export interface Balance {
  available: string;
  pending: string;
  held: string;
  ledger: string;
}

export interface Account {
  id: string;
  account_number: string;
  iban: string;
  bic: string;
  currency: "AED";
  product_code: string;
  status: "open" | "restricted" | "closed";
  opened_at: string;
}

export interface AccountWithBalance {
  account: {
  id: string;
  account_number: string;
  iban: string;
  bic: string;
  currency: "AED";
  product_code: string;
  status: "open" | "restricted" | "closed";
  opened_at: string;
};
  balance: {
  available: string;
  pending: string;
  held: string;
  ledger: string;
};
}

export interface AccountList {
  mode: "sim";
  data: Array<{
  account: {
  id: string;
  account_number: string;
  iban: string;
  bic: string;
  currency: "AED";
  product_code: string;
  status: "open" | "restricted" | "closed";
  opened_at: string;
};
  balance: {
  available: string;
  pending: string;
  held: string;
  ledger: string;
};
}>;
}

export interface BalanceResponse {
  balance: {
  available: string;
  pending: string;
  held: string;
  ledger: string;
};
  version: string;
}

export interface Transaction {
  id: string;
  type: string;
  status: string;
  amount: string;
  currency: "AED";
  reference: string | null;
  value_date: string;
  booking_date: string;
  posted_at: string;
}

export interface TransactionList {
  mode: "sim";
  data: Array<{
  id: string;
  type: string;
  status: string;
  amount: string;
  currency: "AED";
  reference: string | null;
  value_date: string;
  booking_date: string;
  posted_at: string;
}>;
  next_cursor?: string | null;
}

export interface Hold {
  id: string;
  account_id: string;
  status: "active" | "released" | "expired" | "captured";
  amount: string;
  currency: "AED";
  reason: string;
  reference: string | null;
  expires_at: string | null;
  released_at: string | null;
  captured_transaction_id: string | null;
  created_at: string;
}

export interface HoldList {
  mode: "sim";
  data: Array<{
  id: string;
  account_id: string;
  status: "active" | "released" | "expired" | "captured";
  amount: string;
  currency: "AED";
  reason: string;
  reference: string | null;
  expires_at: string | null;
  released_at: string | null;
  captured_transaction_id: string | null;
  created_at: string;
}>;
}

export interface HoldResponse {
  mode: string;
  hold: {
  id: string;
  account_id: string;
  status: "active" | "released" | "expired" | "captured";
  amount: string;
  currency: "AED";
  reason: string;
  reference: string | null;
  expires_at: string | null;
  released_at: string | null;
  captured_transaction_id: string | null;
  created_at: string;
};
  balance: {
  available: string;
  pending: string;
  held: string;
  ledger: string;
};
}

export interface Payout {
  id: string;
  account_id: string;
  status: "created" | "validated" | "submitted" | "accepted" | "settled" | "returned" | "failed" | "cancelled";
  amount: string;
  currency: "AED";
  reference: string | null;
  end_to_end_id: string | null;
  beneficiary: {
  name: string;
  iban: string;
  bic: string | null;
};
  hold_id: string | null;
  transaction_id: string | null;
  settled_amount: string | null;
  scheduled_for: string;
  cutoff_at: string;
  submitted_at: string | null;
  settled_at: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface PayoutResponse {
  mode: string;
  payout: {
  id: string;
  account_id: string;
  status: "created" | "validated" | "submitted" | "accepted" | "settled" | "returned" | "failed" | "cancelled";
  amount: string;
  currency: "AED";
  reference: string | null;
  end_to_end_id: string | null;
  beneficiary: {
  name: string;
  iban: string;
  bic: string | null;
};
  hold_id: string | null;
  transaction_id: string | null;
  settled_amount: string | null;
  scheduled_for: string;
  cutoff_at: string;
  submitted_at: string | null;
  settled_at: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
};
  balance: {
  available: string;
  pending: string;
  held: string;
  ledger: string;
} | null;
}

export interface PayoutDetail {
  mode: string;
  payout: {
  id: string;
  account_id: string;
  status: "created" | "validated" | "submitted" | "accepted" | "settled" | "returned" | "failed" | "cancelled";
  amount: string;
  currency: "AED";
  reference: string | null;
  end_to_end_id: string | null;
  beneficiary: {
  name: string;
  iban: string;
  bic: string | null;
};
  hold_id: string | null;
  transaction_id: string | null;
  settled_amount: string | null;
  scheduled_for: string;
  cutoff_at: string;
  submitted_at: string | null;
  settled_at: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
};
  events: Array<Record<string, unknown>>;
}

export interface PayoutList {
  mode: "sim";
  data: Array<{
  id: string;
  account_id: string;
  status: "created" | "validated" | "submitted" | "accepted" | "settled" | "returned" | "failed" | "cancelled";
  amount: string;
  currency: "AED";
  reference: string | null;
  end_to_end_id: string | null;
  beneficiary: {
  name: string;
  iban: string;
  bic: string | null;
};
  hold_id: string | null;
  transaction_id: string | null;
  settled_amount: string | null;
  scheduled_for: string;
  cutoff_at: string;
  submitted_at: string | null;
  settled_at: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}>;
}

export interface Scenario {
  id: string;
  tenant_id: string;
  account_id: string;
  payout_id: string;
  kind: "underpaid" | "sanctions_hold" | "bank_timeout" | "returned";
  shortfall_minor: string | null;
  shortfall: string | null;
  status: "armed" | "consumed" | "disarmed";
  armed_at: string;
  consumed_at: string | null;
  created_at: string;
}

export interface ScenarioResponse {
  mode: string;
  scenario: {
  id: string;
  tenant_id: string;
  account_id: string;
  payout_id: string;
  kind: "underpaid" | "sanctions_hold" | "bank_timeout" | "returned";
  shortfall_minor: string | null;
  shortfall: string | null;
  status: "armed" | "consumed" | "disarmed";
  armed_at: string;
  consumed_at: string | null;
  created_at: string;
};
}

export interface ScenarioList {
  mode: "sim";
  data: Array<{
  id: string;
  tenant_id: string;
  account_id: string;
  payout_id: string;
  kind: "underpaid" | "sanctions_hold" | "bank_timeout" | "returned";
  shortfall_minor: string | null;
  shortfall: string | null;
  status: "armed" | "consumed" | "disarmed";
  armed_at: string;
  consumed_at: string | null;
  created_at: string;
}>;
}

export interface Statement {
  account_id: string;
  iban: string;
  from: string;
  to: string;
  opening_balance: string;
  closing_balance: string;
  totals: {
  credits: string;
  debits: string;
  count: number;
};
  lines: Array<Record<string, unknown>>;
}

export interface Eod {
  id: string;
  account_id: string;
  business_date: string;
  status: string;
  opening_balance: string;
  closing_balance: string;
  credits: string;
  debits: string;
  line_count: number;
  checksum: string;
  closed_at: string;
  closed_by: string;
}

export interface EodResponse {
  mode: string;
  eod: {
  id: string;
  account_id: string;
  business_date: string;
  status: string;
  opening_balance: string;
  closing_balance: string;
  credits: string;
  debits: string;
  line_count: number;
  checksum: string;
  closed_at: string;
  closed_by: string;
};
}

export interface EodList {
  mode: "sim";
  data: Array<{
  id: string;
  account_id: string;
  business_date: string;
  status: string;
  opening_balance: string;
  closing_balance: string;
  credits: string;
  debits: string;
  line_count: number;
  checksum: string;
  closed_at: string;
  closed_by: string;
}>;
  account_id?: string;
  last_closed_business_date?: string | null;
}

export interface Subscription {
  id: string;
  url: string;
  events: Array<string>;
  description: string | null;
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
}

export interface SubscriptionResponse {
  mode: string;
  subscription: {
  id: string;
  url: string;
  events: Array<string>;
  description: string | null;
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
};
  secret: string | null;
}

export interface SubscriptionList {
  mode: "sim";
  data: Array<{
  id: string;
  url: string;
  events: Array<string>;
  description: string | null;
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
}>;
}

export interface Delivery {
  id: string;
  subscription_id: string;
  event_id: string;
  status: "pending" | "delivering" | "delivered" | "failed" | "dead";
  attempts: number;
  max_attempts: number;
  next_retry_at: string;
  last_status_code: number | null;
  last_error: string | null;
  signature: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliveryList {
  mode: "sim";
  data: Array<{
  id: string;
  subscription_id: string;
  event_id: string;
  status: "pending" | "delivering" | "delivered" | "failed" | "dead";
  attempts: number;
  max_attempts: number;
  next_retry_at: string;
  last_status_code: number | null;
  last_error: string | null;
  signature: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}>;
}

export interface DeliveryResponse {
  mode: string;
  delivery: {
  id: string;
  subscription_id: string;
  event_id: string;
  status: "pending" | "delivering" | "delivered" | "failed" | "dead";
  attempts: number;
  max_attempts: number;
  next_retry_at: string;
  last_status_code: number | null;
  last_error: string | null;
  signature: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
};
}

export interface EventList {
  mode: "sim";
  data: Array<{
  seq: number;
  id: string;
  type: string;
  account_id: string | null;
  data: Record<string, unknown>;
  created_at: string;
}>;
  next_cursor?: string | null;
  has_more?: boolean;
}

export interface AuditList {
  mode: "sim";
  data: Array<{
  id: number;
  tenant_id: string | null;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  request_id: string | null;
  at: string;
}>;
}

export interface ClockState {
  frozen: boolean;
  base: string | null;
  now: string;
}

export interface OpsUser {
  id: string;
  email: string;
  display_name: string;
  role: "viewer" | "operator" | "admin";
  status: "active" | "disabled";
  created_at: string;
  last_login_at: string | null;
}

export interface OpsPrincipal {
  session_id: string | null;
  user_id: string | null;
  email: string;
  display_name: string;
  role: "viewer" | "operator" | "admin";
  via: "session" | "dev-token";
}

export interface LoginResponse {
  mode: string;
  token: string;
  expires_at: string;
  user: {
  id: string;
  email: string;
  display_name: string;
  role: "viewer" | "operator" | "admin";
  status: "active" | "disabled";
  created_at: string;
  last_login_at: string | null;
};
}

export interface MessageResponse {
  mode: string;
  logged_out: boolean;
}

export interface VersionInfo {
  mode: string;
  service: string;
  version: string;
  commit: string;
  schema_version: string | null;
  node: string;
}
