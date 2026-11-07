# Changelog

All notable changes to the S2 bank simulator. SemVer; `v0.1.0` is the first
deployed contract, `v1.0.0` the first frozen contract.

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
