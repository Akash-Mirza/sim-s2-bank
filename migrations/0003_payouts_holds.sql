-- 0003_payouts_holds.sql - holds and outgoing local AED payouts.
-- Holds reduce available without moving the ledger. A payout reserves funds with a
-- hold, then settles by posting the debit and capturing that hold in one transaction.

CREATE TABLE holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'AED' CHECK (currency = 'AED'),
  reason text NOT NULL,
  reference text,
  status text NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'released', 'expired', 'captured')
  ),
  expires_at timestamptz,
  released_at timestamptz,
  captured_transaction_id uuid REFERENCES transactions (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX holds_account_status_idx ON holds (account_id, status);
CREATE INDEX holds_tenant_idx ON holds (tenant_id, created_at DESC);

CREATE TABLE payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'AED' CHECK (currency = 'AED'),
  reference text,
  end_to_end_id text,
  beneficiary_name text NOT NULL,
  beneficiary_iban varchar(34) NOT NULL,
  beneficiary_bic varchar(11),
  status text NOT NULL DEFAULT 'created' CHECK (
    status IN ('created', 'validated', 'submitted', 'accepted', 'settled', 'returned', 'failed', 'cancelled')
  ),
  hold_id uuid REFERENCES holds (id) ON DELETE RESTRICT,
  transaction_id uuid REFERENCES transactions (id) ON DELETE RESTRICT,
  failure_code text,
  failure_reason text,
  scheduled_for date NOT NULL,
  cutoff_at timestamptz NOT NULL,
  submitted_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payouts_account_idx ON payouts (account_id, created_at DESC);
CREATE INDEX payouts_tenant_status_idx ON payouts (tenant_id, status, created_at DESC);

CREATE TABLE payout_events (
  id bigserial PRIMARY KEY,
  payout_id uuid NOT NULL REFERENCES payouts (id) ON DELETE RESTRICT,
  from_status text,
  to_status text NOT NULL,
  actor text NOT NULL,
  meta jsonb,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payout_events_payout_idx ON payout_events (payout_id, at);
