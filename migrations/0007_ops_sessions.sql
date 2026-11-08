-- 0007_ops_sessions.sql - real operator identity for the ops surface.
-- Until S2-10 every /ops/v1 route trusted one shared dev token. Production now gets
-- named users with a role and a short-lived session token, so an ops action has an
-- actor and a session in the audit trail instead of "ops:dev".

CREATE TABLE ops_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stored lower-case; the unique index then makes email comparison exact.
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  display_name text NOT NULL,
  -- scrypt hash, never the password. Format: scrypt$N$r$p$saltHex$hashHex
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ops_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES ops_users (id) ON DELETE RESTRICT,
  -- The token is ops_<prefix>_<secret>; only the prefix is indexed in clear.
  token_prefix text NOT NULL UNIQUE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ops_sessions_user_expiry_idx ON ops_sessions (user_id, expires_at DESC);
CREATE INDEX ops_sessions_active_idx ON ops_sessions (expires_at) WHERE revoked_at IS NULL;
