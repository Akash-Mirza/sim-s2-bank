-- 0005_outbox_webhooks.sql - transactional outbox, subscriptions and deliveries.
-- Every money-changing transaction writes its event into outbox_events in the same
-- transaction, so an event cannot exist without the change and vice versa. A
-- dispatcher later turns matching events into signed HTTP deliveries.

CREATE TABLE outbox_events (
  seq bigint GENERATED ALWAYS AS IDENTITY,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  account_id uuid REFERENCES accounts (id) ON DELETE RESTRICT,
  type text NOT NULL,
  payload jsonb NOT NULL,
  -- Set when every delivery for this event has reached a terminal state.
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_events_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX outbox_events_seq_key ON outbox_events (seq);
CREATE INDEX outbox_events_tenant_seq_idx ON outbox_events (tenant_id, seq);
CREATE INDEX outbox_events_unpublished_idx ON outbox_events (created_at) WHERE published_at IS NULL;

CREATE TABLE webhook_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  url text NOT NULL,
  -- AES-256-GCM ciphertext; the plaintext signing secret is shown once at creation.
  secret_encrypted text NOT NULL,
  events text[] NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_subscriptions_events_not_empty CHECK (cardinality(events) > 0)
);

CREATE INDEX webhook_subscriptions_tenant_status_idx ON webhook_subscriptions (tenant_id, status);

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  subscription_id uuid NOT NULL REFERENCES webhook_subscriptions (id) ON DELETE RESTRICT,
  event_id uuid NOT NULL REFERENCES outbox_events (id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'delivering', 'delivered', 'failed', 'dead')
  ),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts int NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  next_retry_at timestamptz NOT NULL DEFAULT now(),
  last_status_code int,
  last_error text,
  signature text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, event_id)
);

CREATE INDEX webhook_deliveries_due_idx
  ON webhook_deliveries (next_retry_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX webhook_deliveries_tenant_created_idx
  ON webhook_deliveries (tenant_id, created_at DESC);
