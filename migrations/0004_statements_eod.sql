-- 0004_statements_eod.sql - daily statement snapshots and sequential EOD state.
-- The ledger remains the source of truth. A daily_ledger_entries row is an immutable
-- close-of-business snapshot that proves the statement's opening, closing and totals
-- at the moment the day was closed.

CREATE TABLE daily_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  business_date date NOT NULL,
  opening_minor bigint NOT NULL CHECK (opening_minor >= 0),
  closing_minor bigint NOT NULL CHECK (closing_minor >= 0),
  credits_minor bigint NOT NULL CHECK (credits_minor >= 0),
  debits_minor bigint NOT NULL CHECK (debits_minor >= 0),
  line_count int NOT NULL CHECK (line_count >= 0),
  checksum text NOT NULL,
  status text NOT NULL DEFAULT 'closed' CHECK (status IN ('closed')),
  closed_at timestamptz NOT NULL DEFAULT now(),
  closed_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_ledger_entries_balance CHECK (
    closing_minor = opening_minor + credits_minor - debits_minor
  ),
  UNIQUE (account_id, business_date)
);

CREATE INDEX daily_ledger_entries_tenant_date_idx
  ON daily_ledger_entries (tenant_id, business_date DESC);

-- One close pointer per account. A tenant can have several corporate accounts, so
-- sequential EOD is enforced per account, not globally per tenant.
CREATE TABLE eod_state (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  last_closed_business_date date,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id)
);
