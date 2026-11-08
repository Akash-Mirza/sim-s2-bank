-- 0006_failure_scenarios.sql - armed failure scenarios and partial settlement.
-- A scenario is a deliberate, observable fault the demo/ops surface arms against one
-- payout: underpaid, sanctions_hold, bank_timeout or returned. The payout transition
-- consults the armed row in the same transaction that moves money, so a scenario can
-- never be applied twice and can never fire without the business change.

CREATE TABLE simulator_scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  payout_id uuid NOT NULL REFERENCES payouts (id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('underpaid', 'sanctions_hold', 'bank_timeout', 'returned')),
  -- Only `underpaid` uses this: how much of the payout never reaches the beneficiary.
  shortfall_minor bigint CHECK (shortfall_minor IS NULL OR shortfall_minor > 0),
  status text NOT NULL DEFAULT 'armed' CHECK (status IN ('armed', 'consumed', 'disarmed')),
  armed_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT simulator_scenarios_shortfall_kind
    CHECK (shortfall_minor IS NULL OR kind = 'underpaid')
);

-- One live scenario per payout: two armed faults would make the transition ambiguous.
CREATE UNIQUE INDEX simulator_scenarios_one_armed_per_payout
  ON simulator_scenarios (payout_id)
  WHERE status = 'armed';

CREATE INDEX simulator_scenarios_tenant_created_idx
  ON simulator_scenarios (tenant_id, created_at DESC);

-- What the beneficiary actually received. NULL until settlement; equal to
-- amount_minor unless an `underpaid` scenario fired.
ALTER TABLE payouts
  ADD COLUMN settled_amount_minor bigint
    CHECK (settled_amount_minor IS NULL OR settled_amount_minor > 0);
