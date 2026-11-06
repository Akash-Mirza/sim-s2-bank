-- 0002_idempotency.sql - replay-safe writes.
-- The row is written in the same transaction as the business change, so a crash can
-- never leave "key stored, money not moved" or "money moved, key not stored".

CREATE TABLE idempotency_keys (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 255),
  request_hash text NOT NULL,
  method text NOT NULL,
  route text NOT NULL,
  response_status int NOT NULL CHECK (response_status BETWEEN 200 AND 299),
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (tenant_id, key)
);

CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);
