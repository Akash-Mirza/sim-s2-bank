# Changelog

All notable changes to the S2 bank simulator. SemVer; `v0.1.0` is the first
deployed contract, `v1.0.0` the first frozen contract.

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
