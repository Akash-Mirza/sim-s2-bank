# Changelog

All notable changes to the S2 bank simulator. SemVer; `v0.1.0` is the first
deployed contract, `v1.0.0` the first frozen contract.

## [0.7.0-dev.0] — 2026-11-08

Phase 11 of the S2 build (`S2-11`).

### Added

- `src/contracts/spec.ts`: the API contract as a typed route table (53 routes) plus
  component schemas in a small JSON Schema subset.
- `openapi.yaml` at the repo root, generated from the route table, with both
  security schemes, per-operation scopes, the `Idempotency-Key` parameter on every
  write that needs it, and documented error statuses.
- `src/contracts/api-types.ts`: generated TypeScript interfaces for every component.
- `pnpm openapi` writes both artifacts; `pnpm openapi:check` fails when either is
  stale.
- `test/contract/spec.test.ts`: route-table parity with the running Fastify server
  (via a new `onRoute` hook on `buildServer`), idempotency-coverage enforcement with
  the exemption list pinned, generated-file drift checks, and runtime checks of the
  documented error envelope and `x-request-id` echo.
- `pnpm test` now runs unit + contract tests; `pnpm test:contract` runs the contract
  suite alone.

### Changed

- `buildServer(env, { onRoute })` can report every registered route, which is what
  makes the parity test possible without a live database.
- `src/contracts/api-types.ts` is excluded from Biome so regeneration is
  deterministic and the drift check is meaningful.
- Version is `0.7.0-dev.0`.

### Known limits
- The contract is not validated by an external OpenAPI validator; the suite checks
  structure, parity and runtime envelopes, not every OpenAPI rule.
- Statement payloads advertise their content types, but the contract does not model
  every MT940 subfield.
- Contract tests need no database; they do not exercise authenticated success paths
  (those are the integration suite).

## [0.6.0-dev.0] — 2026-11-08

Phase 10 of the S2 build (`S2-10`).

### Added

- `0007_ops_sessions.sql`: `ops_users` (email, display name, scrypt password hash,
  role, status) and `ops_sessions` (token prefix, hash, expiry, revocation).
- Ops sessions: `POST /ops/v1/auth/login`, `POST /ops/v1/auth/logout`,
  `GET /ops/v1/auth/me`. Tokens are `ops_<prefix>_<secret>`, stored as
  `sha256(pepper:ops-session:secret)` with a 12-hour default TTL
  (`OPS_SESSION_TTL_HOURS`).
- Roles: `viewer` is read-only, `operator` may change state, `admin` may manage
  users. The guard enforces the role, so individual routes do not.
- `requireOps`: one guard for every `/ops/v1` route. Bearer sessions work in
  production; the shared `x-ops-token` works only where `ENABLE_DEV_OPS` is true,
  which production already forbids at boot.
- Ops console at `GET /ops/console` (and `/ops` → redirect): login, Accounts,
  Payouts, Scenarios, Webhooks and Audit tabs, served by the API as one HTML page
  so it ships through the same Vercel function.
- Ops read routes for the console: `GET /ops/v1/accounts`, `/ops/v1/payouts`,
  `/ops/v1/audit`, `/ops/v1/webhooks/deliveries`.
- `DELETE /ops/v1/scenarios/{id}` so an operator can disarm a fault.
- Ops writes now record `ops:<email>` as the audit actor instead of `ops:dev`.
- `pnpm ops:user create|list` CLI (password from `--password` or
  `OPS_USER_PASSWORD`, never printed).
- Unit tests for scrypt hashing and token parsing; integration tests for login,
  logout, roles, production-mode sessions and the console page.

### Changed

- The ops surface no longer depends on `ENABLE_DEV_OPS` in production: a deployed
  simulator is operable with named users and roles, which was the blocker recorded
  in A9/A11.
- Payout and scenario ops actions now use the session identity for the payout event
  actor instead of `ops:dev`.
- Version is `0.6.0-dev.0`.

### Known limits

- No SSO, MFA, login throttling or per-device session management.
- The console page is public HTML; every read behind it requires a session.
- `admin` exists for user management but the user-management routes are not built;
  users are created with the CLI.
- Nothing auto-advances payouts or drains the outbox; the console still triggers
  both.

## [0.5.0-dev.0] — 2026-11-08

Phase 9 of the S2 build (`S2-09`).

### Added

- `0006_failure_scenarios.sql`: `simulator_scenarios` (one armed fault per payout,
  enforced by a partial unique index) and `payouts.settled_amount_minor`.
- Four failure scenarios: `underpaid`, `sanctions_hold`, `bank_timeout` and
  `returned`. Each bends or refuses exactly one payout transition instead of
  adding a parallel state machine.
- `underpaid` settles the payout for `amount - shortfall`, releases the full
  reserve and records `settled_amount` plus `failure_code: underpaid`.
- `sanctions_hold` refuses `accepted`/`settled` with `423 payment_held` and stays
  armed until the operator disarms it.
- `bank_timeout` refuses `submitted -> accepted` with `504 rail_timeout`, leaving
  the payout `submitted` and the hold active for a retry.
- `returned` redirects `submitted -> accepted` into `submitted -> returned`, which
  releases the reserve without moving the ledger.
- Tenant routes `POST/GET /v1/scenarios` and `DELETE /v1/scenarios/{id}`; ops
  routes `POST/GET /ops/v1/scenarios`; `/v1/meta` now lists the scenario kinds.
- Scenarios are consumed inside the money transaction, so a fault fires once and
  its audit row (`scenario.armed` / `scenario.disarmed`) commits with it.
- Unit tests for the resolution rules and integration tests for underpaid,
  sanctions hold, timeout, return, disarm and tenant isolation.

### Changed

- Reversal of a settled payout now reverses `settled_amount_minor`, not the
  original payout amount, so an underpaid payout cannot be reversed for more than
  it paid.
- Version is `0.5.0-dev.0`.

### Known limits

- Scenarios are armed per payout, not per account or per tenant.
- Only one scenario may be armed on a payout at a time.
- Nothing auto-advances payouts: a demo still calls `advance` or the console.
- The ops surface is still the shared `x-ops-token` until `S2-10`.

## [0.4.0-dev.0] — 2026-11-07

Phase 8 of the S2 build (`S2-08`).

### Added

- `0005_outbox_webhooks.sql`: `outbox_events` with a monotonic `seq` cursor,
  `webhook_subscriptions` with an encrypted signing secret, and
  `webhook_deliveries` with attempts, backoff, last status/error and signature.
- Transactional outbox: credits, reversals, holds, payout transitions and EOD
  closes write their event in the same transaction as the business change.
- Event registry and filters: exact types, families (`payout.*`) and `*`.
- HMAC-SHA256 signing (`x-sim-signature: t=<unix>,v1=<hex>` over
  `${t}.${body}`) with a 5-minute verification tolerance.
- Webhook secrets are `whsec_…`, shown at registration, stored AES-256-GCM
  encrypted with `WEBHOOK_SECRET_KEY` or a distinct key derived from
  `API_KEY_PEPPER`.
- At-least-once delivery with a 5-second timeout, exponential backoff
  (`2^attempts` seconds, capped at 300s), 5 attempts, then dead-letter.
- `FOR UPDATE SKIP LOCKED` claiming so concurrent dispatchers cannot double-send;
  stale `delivering` rows are re-queued after a crash.
- Tenant routes: register/list/disable subscriptions, delivery history, and a
  cursor pull API (`GET /v1/events?after=<seq>`).
- Ops routes: cross-tenant dispatch and delivery replay.
- Unit tests for filters, URL policy, backoff, encryption and signatures;
  integration tests with a real local HTTP receiver for signed delivery, retry,
  dead-letter/replay, isolation, scopes, pagination and disable.

### Changed

- Default API-key scopes now include `webhooks:read`, `webhooks:write` and
  `events:read`.
- `/v1/outbox/dispatch` and `/ops/v1/outbox/dispatch` are control-plane ticks and
  are exempt from `Idempotency-Key`; every other write still requires it.
- Version is `0.4.0-dev.0`.

### Deployed

- Live demo at `https://sim-s2-bank.vercel.app` on Vercel Functions in `sin1`
  with Neon Postgres in `ap-southeast-1`; schema
  `0005_outbox_webhooks.sql`, `ENABLE_DEV_OPS=false`.
- `vercel.json` disables framework detection so the explicit `api/index.ts`
  Fastify handler is used, pins functions to `sin1`, and the functions-only
  project ships an empty `public/` output directory.
- Production smoke: accounts, JSON/MT940 statements, EOD close, event pull,
  webhook registration and dispatch all pass; both `credit.posted` and
  `eod.closed` delivered with HTTP 200 and a receiver-recomputed valid HMAC.

### Known limits

- Delivery is in-process: nothing runs a worker on a schedule; a cron or the ops
  endpoint must call dispatch.
- Events are stored forever (no retention policy yet).
- No per-subscription rate limit or circuit breaker beyond attempt backoff.
- No failure scenarios, ops console or OpenAPI yet.

## [0.3.0-dev.0] — 2026-11-07

Phase 7 of the S2 build (`S2-07`).

### Added

- `0004_statements_eod.sql`: immutable `daily_ledger_entries` snapshots and a
  per-tenant/account `eod_state` pointer.
- Statements for any booking-date range in JSON, CSV and MT940, all rendered from
  one statement model with opening/closing balances checked against
  `ledger_entries.balance_after_minor`.
- Sequential EOD close (`POST /v1/accounts/{id}/eod/close`) with replay-safe
  writes, per-account sequence, next-business-day enforcement, checksum and audit
  row; EOD history and single-snapshot reads.
- Adjustable simulator clock: `SIM_CLOCK` starts it frozen; dev ops routes
  `GET /ops/v1/clock`, `POST /ops/v1/clock/freeze`, `step` and `resume`.
- Unit tests for statement rendering/reconciliation, EOD sequencing and the clock;
  integration tests for cross-format agreement, date ranges, tenant isolation,
  EOD replay/sequence and clock-driven close dates.

### Changed

- `/ops/v1/clock/*` is deliberately exempt from `Idempotency-Key`; a step is
  control-plane input, not a replayable business write.
- Server composition uses the adjustable clock instead of an immutable fixed clock.

### Known limits

- A statement scans at most 366 days; CAMT.053/PDF are not built.
- EOD is per account; a tenant with several accounts closes each one separately.
- Hold expiry is still stored but not swept by a worker.
- No webhooks/outbox, failure scenarios, ops console, OpenAPI, or live deploy yet.

## [0.2.0-dev.0] — 2026-11-07

Phases 5–6 of the S2 build (`S2-05`, `S2-06`).

### Added

- `0002_idempotency.sql`: tenant-scoped `idempotency_keys` with request hash,
  stored response, route, and a 24-hour expiry.
- Idempotent write helper: the key row, the business change, and the stored
  response commit in one transaction; concurrent identical requests serialize on
  an advisory lock. Replay sets `idempotent-replayed: true`; a reused key with a
  different body or route returns `409 idempotency_conflict`.
- `Idempotency-Key` is now required on every `POST`/`DELETE` (tenant and ops).
- `0003_payouts_holds.sql`: `holds`, `payouts`, append-only `payout_events`.
- Holds: create reserves available without touching the ledger; release is
  idempotent; capture happens only with a settlement debit.
- Local AED payouts: beneficiary IBAN/BIC validation, AED 500,000 cap, the
  created→validated→submitted→accepted→settled machine, cancel, fail, return,
  and a reversal credit for settled funds.
- UAE business calendar (Asia/Dubai, Sat/Sun weekend, 2026 holidays) and 15:00
  cut-off; after cut-off the payout is scheduled for the next business day.
- Dev ops endpoints `payouts/{id}/advance` and `payouts/{id}/reverse`.
- `payouts:read` / `payouts:write` scopes on issued API keys.

### Fixed

- Account-number collision retry now uses a savepoint instead of poisoning the
  surrounding transaction.

### Known limits

- Beneficiaries are inline on the payout; the beneficiary book is not built.
- Hold expiry is stored but no worker expires holds yet.
- No statements, webhooks, failure scenarios, ops console, OpenAPI, or live deploy.
- Payout advance/cancel travel through the API; a background rail worker arrives
  with the outbox in `S2-08`.

## [0.1.0-dev.0] — 2026-11-06

Phases 1–4 of the S2 build (`S2-01`…`S2-04`).

### Added

- Portable Fastify 5 server with `/health`, `/ready`, `/version`, `/v1/meta`,
  request ids, structured logs, and fail-fast environment validation.
- Dockerfile, compose stack (Postgres + one-shot migrate job + API), Vercel Node
  handler, GitHub Actions CI with a fresh-Postgres integration job.
- `0001_init.sql`: tenants, API keys, accounts, balance cache, transactions,
  ledger entries, audit log; money as `bigint` fils with AED/positive constraints.
- Numbered SQL migration runner and `schema_migrations` ledger.
- Domain rules: strict AED minor-unit money, UAE IBAN build + mod-97 check,
  balanced double-entry pairs, available-balance arithmetic with no overdraft.
- Atomic posting use case: row lock, rule enforcement, transaction + entries +
  balance update + audit entry in one commit.
- Account creation with generated 16-digit number and virtual UAE IBAN, bearer API
  key authentication, account/balance/transaction read endpoints.
- Dev-only ops credit-injection endpoint behind `ENABLE_DEV_OPS` and
  `x-ops-token`; production refuses to boot with it enabled.
- Idempotent seed and guarded reset CLI.

### Known limits

- `Idempotency-Key` is accepted but not enforced (lands in `S2-05`).
- No holds, payouts, statements, webhooks, ops console, or OpenAPI yet.
- Vercel and Docker deploys are configured, not yet verified against a live host.
