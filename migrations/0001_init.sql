-- 0001_init.sql - tenants, accounts, balances, transactions, ledger, audit.
-- Money is bigint minor units (fils). Posted rows are immutable; corrections are reversals.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  legal_name text NOT NULL,
  jurisdiction text NOT NULL DEFAULT 'AE',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  prefix text NOT NULL UNIQUE,
  secret_hash text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  account_number char(16) NOT NULL UNIQUE,
  iban varchar(34) NOT NULL UNIQUE,
  bic varchar(11) NOT NULL,
  currency char(3) NOT NULL DEFAULT 'AED' CHECK (currency = 'AED'),
  product_code text NOT NULL DEFAULT 'corporate_current',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'restricted', 'closed')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX accounts_tenant_idx ON accounts (tenant_id);

CREATE TABLE account_balances (
  account_id uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE RESTRICT,
  available_minor bigint NOT NULL DEFAULT 0,
  pending_minor bigint NOT NULL DEFAULT 0,
  held_minor bigint NOT NULL DEFAULT 0,
  ledger_minor bigint NOT NULL DEFAULT 0,
  version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_balances_non_negative CHECK (
    available_minor >= 0 AND pending_minor >= 0 AND held_minor >= 0
  )
);

CREATE TABLE transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  type text NOT NULL CHECK (
    type IN ('credit_transfer', 'payout', 'fee', 'reversal', 'hold_capture', 'interest')
  ),
  status text NOT NULL DEFAULT 'posted' CHECK (
    status IN ('pending', 'posted', 'reversed', 'returned', 'failed')
  ),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'AED' CHECK (currency = 'AED'),
  reference text,
  end_to_end_id text,
  remitter_name text,
  remitter_iban varchar(34),
  remitter_bic varchar(11),
  value_date date NOT NULL,
  booking_date date NOT NULL,
  posted_at timestamptz,
  scenario text,
  reversal_of uuid REFERENCES transactions (id) ON DELETE RESTRICT,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX transactions_account_booking_idx
  ON transactions (account_id, booking_date DESC, created_at DESC);
CREATE INDEX transactions_reference_idx ON transactions (reference);
CREATE INDEX transactions_end_to_end_idx ON transactions (end_to_end_id);

CREATE TABLE ledger_entries (
  id bigserial PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES transactions (id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  ledger_account text NOT NULL CHECK (
    ledger_account IN ('customer_deposit', 'uaefts_clearing', 'aani_clearing', 'fee_income', 'suspense')
  ),
  direction char(1) NOT NULL CHECK (direction IN ('D', 'C')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'AED' CHECK (currency = 'AED'),
  balance_after_minor bigint,
  value_date date NOT NULL,
  booking_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, created_at);
CREATE INDEX ledger_entries_transaction_idx ON ledger_entries (transaction_id);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  tenant_id uuid REFERENCES tenants (id) ON DELETE RESTRICT,
  actor text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  before jsonb,
  after jsonb,
  request_id text,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, at DESC);
