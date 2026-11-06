# Changelog

All notable changes to the S2 bank simulator. SemVer; `v0.1.0` is the first
deployed contract, `v1.0.0` the first frozen contract.

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
