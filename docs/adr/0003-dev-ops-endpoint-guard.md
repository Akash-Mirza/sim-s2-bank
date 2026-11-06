# ADR 0003 — Dev-only ops credit endpoint before ops auth exists

Status: accepted, temporary (S2-04, 2026-11-06)

## Context

Phases 1–4 ship a ledger with no way to create money except tests, because the
tenant-facing `credits:simulate` contract belongs with idempotency (`S2-05`) and
the ops console with session auth (`S2-10`). A phase that cannot be exercised
against a running deployment is not verifiable.

## Decision

Expose `POST /ops/v1/accounts/{id}/simulate-credit`, guarded by:

1. `ENABLE_DEV_OPS=true` — otherwise the whole `/ops/` surface returns 404;
2. `x-ops-token` equal to `OPS_DEV_TOKEN`;
3. environment validation that refuses to start when `NODE_ENV=production` and
   `ENABLE_DEV_OPS=true`.

## Consequences

- The ledger can be exercised end to end on a preview URL without inventing a
  parallel write path.
- The endpoint is explicitly temporary: `S2-10` replaces the token with the ops
  session + role model, and the route stays under `/ops/v1`.
- Production boot fails closed, so the dev surface cannot leak into a demo host
  by forgetting a flag.
- This is the only unauthenticated-by-key write route in the release and it is
  documented in `SPEC.md`.
