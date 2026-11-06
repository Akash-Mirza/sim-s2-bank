# S2 — Bank Simulator Specification (v0.1.0-dev.0)

Scope: phases 1–4 (`S2-01`…`S2-04`). This document is the source of truth for what
the simulator must do; `openapi.yaml` and the remaining packets are not built yet.

## 1. Purpose and boundary

S2 is the money rail the product integrates against. It holds the issuer's
corporate AED account, proves balances and movements, and later simulates
payouts and statements.

In scope now:

- one or more AED corporate accounts per tenant, with a virtual UAE IBAN and BIC;
- available / pending / held / ledger balances;
- simulated incoming credit;
- a double-entry ledger with immutable posted rows;
- tenant resolution from an API key;
- an audit trail for every posting and account opening.

Out of scope: real money, real PII, real bank connectivity, KYB (S3), FX (S9),
cross-border (S10), webhooks and statements (later S2 packets).

## 2. Money and ledger rules

| Rule | Requirement |
|---|---|
| Representation | `bigint` minor units (fils); JSON amounts are decimal strings |
| Currency | `AED` only; `char(3)` stored on every amount row |
| Pairing | sum(debits) === sum(credits) for every transaction |
| Credit pair | `D uaefts_clearing` / `C customer_deposit` |
| Debit pair | `D customer_deposit` / `C uaefts_clearing` |
| Overdraft | none — a debit may not take available below zero |
| Book balance | sum of `customer_deposit` credits minus debits |
| Available | book − held − pending |
| Immutability | posted rows are never updated or deleted; corrections are reversals |
| Cache | `account_balances` is a cache; the ledger is the source of truth |

## 3. Data model (0001_init.sql)

`tenants`, `api_keys`, `accounts`, `account_balances`, `transactions`,
`ledger_entries`, `audit_log`, plus `schema_migrations` owned by the runner.

- `accounts.iban` unique, 23-character UAE IBAN (`AE` + check + bank code + 16 digits).
- `ledger_entries.direction` in `D`/`C`; `amount_minor > 0`; `currency = 'AED'`.
- `ledger_entries.balance_after_minor` is stored for the customer leg only.
- Financial foreign keys use `ON DELETE RESTRICT`; money is never cascade-deleted.

## 4. HTTP contract (delivered endpoints)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | none | liveness, no DB |
| GET | `/ready` | none | DB check, 503 when not ready |
| GET | `/version` | none | version, commit, schema version, node |
| GET | `/v1/meta` | none | mode, version, server time, scenarios |
| POST | `/v1/accounts` | bearer | creates account + zero balance, 201 |
| GET | `/v1/accounts` | bearer | tenant's accounts with balances |
| GET | `/v1/accounts/{id}` | bearer | account + balance |
| GET | `/v1/accounts/{id}/balance` | bearer | available/pending/held/ledger |
| GET | `/v1/accounts/{id}/transactions` | bearer | keyset pagination, `limit` ≤ 100 |
| POST | `/v1/accounts/{id}/credits:simulate` | bearer + `accounts:write` | simulated incoming credit |
| POST | `/ops/v1/accounts/{id}/simulate-credit` | `x-ops-token` | **dev only**, requires `ENABLE_DEV_OPS` |

Conventions: `Authorization: Bearer sk_sim_<prefix>_<secret>`; amounts as strings;
every response contains `"mode":"sim"`; errors are
`{"error":{"code","message","request_id","details"}}`; `x-request-id` is echoed.

Errors used so far: `validation_error` 400, `unauthorized` 401, `not_found` 404,
`insufficient_funds` 422, `account_restricted` 423, `internal_error` 500.

`Idempotency-Key` is accepted on writes but **not enforced yet** — enforcement is
packet `S2-05`. Do not rely on replay safety until then.

## 5. Configuration

`DATABASE_URL`, `API_KEY_PEPPER` are required. `API_PORT` (4002), `HOST`,
`NODE_ENV`, `LOG_LEVEL`, `SIM_CLOCK`, `ENABLE_DEV_OPS`, `OPS_DEV_TOKEN`,
`SERVICE_VERSION`, `GIT_COMMIT` have defaults. Production refuses to boot with
`ENABLE_DEV_OPS=true`.

## 6. Acceptance tests (this release)

| ID | Test | Where |
|---|---|---|
| S2-T-001 | `/health`, `/ready`, `/version`, `/v1/meta` respond 200 with `mode: sim` | `test/integration/http.test.ts` |
| S2-T-010 | decimal AED parses to exact fils; rejects zero, negatives, >2 decimals | `test/unit/money.test.ts` |
| S2-T-011 | generated UAE IBAN is 23 chars and passes mod-97 | `test/unit/iban.test.ts` |
| S2-T-012 | credit and debit pairs balance; unbalanced is rejected | `test/unit/ledger.test.ts` |
| S2-T-013 | available = book − held − pending; debit cannot go below zero | `test/unit/balance.test.ts` |
| S2-T-020 | a credit posts two entries and updates the cached balance | `test/integration/ledger.test.ts` |
| S2-T-021 | credits accumulate and a funded debit succeeds | `test/integration/ledger.test.ts` |
| S2-T-022 | an unfunded debit is refused and leaves no partial rows | `test/integration/ledger.test.ts` |
| S2-T-023 | a restricted account refuses postings | `test/integration/ledger.test.ts` |
| S2-T-024 | another tenant's account is not reachable | `test/integration/ledger.test.ts` |
| S2-T-025 | concurrent postings preserve balance and ledger totals | `test/integration/ledger.test.ts` |
| S2-T-026 | HTTP create/list/balance/transactions work with a bearer key | `test/integration/http.test.ts` |
| S2-T-027 | ops routes 404 when dev endpoints are disabled | `test/integration/http.test.ts` |

## 7. Next packets

`S2-05` idempotency, `S2-06` payouts/holds/state machine, `S2-07` statements,
`S2-08` outbox/webhooks, `S2-09` failure scenarios, `S2-10` ops console,
`S2-11` OpenAPI + contract tests, `S2-12` deploy verification, `S2-13` release.
