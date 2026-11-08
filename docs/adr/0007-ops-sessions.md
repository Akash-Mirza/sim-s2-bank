# ADR 0007 — Ops sessions are email + scrypt password + a short-lived bearer token

- Status: accepted
- Date: 2026-11-08
- Packet: `S2-10`

## Context

Until `S2-10`, every `/ops/v1` route trusted one shared `x-ops-token`, and the app
refused to boot in production with dev ops enabled. That made the surface safe but
unusable: a deployed simulator had no operator identity, and the audit trail said
`ops:dev` for every action.

The console also needs to exist. `A9` established that S2's only frontend is the ops
console; the founder portal belongs to `product-core`.

## Decision

1. **Named users.** `ops_users` stores email, display name, a scrypt password hash,
   and one role: `viewer`, `operator` or `admin`. There is no self-registration; the
   `ops-user` CLI creates accounts.
2. **Short-lived sessions.** Login returns `ops_<prefix>_<secret>` and stores only
   the prefix plus `sha256(pepper:ops-session:secret)`, an expiry (12h default,
   `OPS_SESSION_TTL_HOURS`) and a revocation timestamp. Logout revokes the row;
   disabling the user invalidates all their sessions on the next call.
3. **One guard, two credentials.** `requireOps` accepts a Bearer ops session
   anywhere, and the shared `x-ops-token` only when `ENABLE_DEV_OPS` is true — which
   production already forbids at boot. Local scripts and the existing integration
   tests keep working; a deployed simulator cannot use the shared token.
4. **Roles at the edge.** `viewer` is read-only, `operator` may change state,
   `admin` may manage users. The role check lives in the guard, not in each route.
5. **The console is served by the API.** `/ops/console` returns one self-contained
   HTML page and talks to the same `/ops/v1` routes with the session token. No
   second deployment, no CORS, no build step, and it works through the existing
   Vercel rewrite.
6. **The audit actor is a person.** Every ops write records `ops:<email>`, so the
   Audit tab shows who armed a scenario or replayed a delivery.

## Consequences

- Sessions work in production: the simulator no longer needs dev ops enabled to be
  operable, which was the blocker noted in `A9` and `A11`.
- Passwords are hashed with scrypt (N=16384) and never logged; login failure is
  identical for unknown email, disabled user and wrong password.
- A stolen token is useful until it expires or is revoked; there is no refresh
  token, no device list and no per-IP binding. That is proportionate for a demo
  simulator, and documented as a limit.
- The console page is public HTML. It contains no data and no secrets; every read
  behind it needs a session. Hiding the page would not add security.
- The dev token path is a deliberate local escape hatch. It is one config flag away
  from being unreachable, and the boot-time guard makes that flag mandatory in
  production.

## When to revisit

A real operator surface needs SSO (OIDC/SAML), MFA, login throttling, session
listing/revocation per device, and an approval step for sensitive actions. Those
belong with the product's operations module, not the S2 simulator.
