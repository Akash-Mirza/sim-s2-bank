# S2 — Bank Simulator Specification (v0.2.0-dev.0)

Scope: phases 1–6 (`S2-01`…`S2-06`). This document is the source of truth for what
the simulator must do; `openapi.yaml` and the remaining packets are not built yet.

## 1. Purpose and boundary

S2 is the money rail the product integrates against. It holds the issuer's
corporate AED account, proves balances and movements, and simulates local AED
payouts, holds, and the UAE cut-off.

In scope now:

- one or more AED corporate accounts per tenant, with a virtual UAE IBAN and BIC;
- available / pending / held / ledger balances;
- simulated incoming credit with replay-safe writes;
- holds: reserve available without moving the ledger, release, capture;
- local AED payouts with a legal state machine, cut-off and settlement date;
- a double-entry ledger with immutable posted rows;
- tenant resolution from an API key;
- an audit trail for every posting, account opening, hold and payout transition.

Out of scope: real money, real PII, real bank connectivity, KYB (S3), FX (S9),
cross-border (S10), beneficiary book, statements, webhooks, failure scenarios
(later S2 packets).

## 2. Money, ledger, hold and payout rules

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
| Hold | increases `held_minor`; available falls; ledger does not move |
| Hold release | decreases `held_minor`; releasing twice is a no-op |
| Hold capture | only with a settlement debit; `held_minor` falls in the same post |
| Payout reserve | creating a payout takes a hold for the full amount |
| Payout limit | one payout may not exceed AED 500,000.00 |
| Cut-off | 15:00 Asia/Dubai on a UAE business day; after it, next business day |
| Weekends/holidays | Saturday and Sunday closed; 2026 UAE public holidays seeded in code |
| Immutability | posted rows are never updated or deleted; corrections are reversals |
| Cache | `account_balances` is a cache; the ledger is the source of truth |

### 2.1 Payout state machine

```text
created → validated → submitted → accepted → settled
   ↘ cancelled          ↘ failed      ↘ returned
settled → returned  (reversal credit, ops path)
```

Guards and effects:

| Transition | Guard | Effect |
|---|---|---|
| `created → validated` | payout exists, beneficiary IBAN/BIC valid | event only |
| `validated → submitted` | hold active | event only |
| `submitted → accepted` | simulated rail accepts | event only |
| `accepted → settled` | hold active | debit posted, hold captured, `transaction_id` set |
| `created/validated → cancelled` | caller cancels before submission | hold released |
| `any → failed` | simulated rail rejects | hold released |
| `accepted → returned` | simulated rail returns before settlement | hold released |
| `settled → returned` | ops reversal only | reversal credit posted, payout marked returned |

Illegal transitions return `409 invalid_state_transition` with `from`, `to` and
`allowed`. A settled payout cannot be settled twice: the hold is captured, so a
second settlement fails the hold guard.

## 3. Data model

`0001_init.sql`: `tenants`, `api_keys`, `accounts`, `account_balances`,
`transactions`, `ledger_entries`, `audit_log`, plus `schema_migrations`.

`0002_idempotency.sql`: `idempotency_keys` keyed by `(tenant_id, key)`, storing
`request_hash`, `route`, `response_status`, `response_body`, and a 24-hour expiry.

`0003_payouts_holds.sql`: `holds`, `payouts`, `payout_events` (append-only).

- `accounts.iban` unique, 23-character UAE IBAN (`AE` + check + bank code + 16 digits).
- `ledger_entries.direction` in `D`/`C`; `amount_minor > 0`; `currency = 'AED'`.
- `ledger_entries.balance_after_minor` is stored for the customer leg only.
- `payouts.status` is constrained to the state machine; `scheduled_for` and
  `cutoff_at` are computed at creation.
- `holds.status` in `active`, `released`, `expired`, `captured`.
- Financial foreign keys use `ON DELETE RESTRICT`; money is never cascade-deleted.

## 4. HTTP contract (delivered endpoints)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | none | liveness, no DB |
| GET | `/ready` | none | DB check, 503 when not ready |
| GET | `/version` | none | version, commit, schema version, node |
| GET | `/v1/meta` | none | mode, version, server time, scenarios |
| POST | `/v1/accounts` | bearer + `accounts:write` | creates account + zero balance, 201 |
| GET | `/v1/accounts` | bearer | tenant's accounts with balances |
| GET | `/v1/accounts/{id}` | bearer | account + balance |
| GET | `/v1/accounts/{id}/balance` | bearer | available/pending/held/ledger |
| GET | `/v1/accounts/{id}/transactions` | bearer | keyset pagination, `limit` ≤ 100 |
| POST | `/v1/accounts/{id}/credits:simulate` | bearer + `accounts:write` | simulated incoming credit |
| POST | `/v1/accounts/{id}/holds` | bearer + `accounts:write` | reserve available, 201 |
| GET | `/v1/accounts/{id}/holds` | bearer | holds for the account |
| DELETE | `/v1/holds/{id}` | bearer + `accounts:write` | release a hold |
| POST | `/v1/payouts` | bearer + `payouts:write` | create local AED payout, 201 |
| GET | `/v1/payouts` | bearer + `payouts:read` | filter by `status`, `limit` ≤ 100 |
| GET | `/v1/payouts/{id}` | bearer + `payouts:read` | payout + append-only events |
| POST | `/v1/payouts/{id}/cancel` | bearer + `payouts:write` | before submission |
| POST | `/ops/v1/accounts/{id}/simulate-credit` | `x-ops-token` | **dev only** |
| POST | `/ops/v1/payouts/{id}/advance` | `x-ops-token` | advance one step or `{to}` |
| POST | `/ops/v1/payouts/{id}/reverse` | `x-ops-token` | return settled funds |

Conventions: `Authorization: Bearer sk_sim_<prefix>_<secret>`; amounts as strings;
every response contains `"mode":"sim"`; errors are
`{"error":{"code","message","request_id","details"}}`; `x-request-id` is echoed.

Writes: `POST` and `DELETE` require `Idempotency-Key` (1–255 printable ASCII).
Same key + same body replays the stored response with `idempotent-replayed: true`.
Same key + different body or route returns `409 idempotency_conflict`. Failed
requests are not cached. Keys expire after 24 hours.

Errors used so far: `validation_error` 400, `unauthorized` 401, `forbidden` 403,
`not_found` 404, `idempotency_conflict` 409, `invalid_state_transition` 409,
`invalid_iban` 422, `invalid_bic` 422, `cutoff_passed` 422,
`amount_out_of_range` 422, `insufficient_funds` 422, `account_restricted` 423,
`internal_error` 500.

## 5. Configuration

`DATABASE_URL`, `API_KEY_PEPPER` are required. `API_PORT` (4002), `HOST`,
`NODE_ENV`, `LOG_LEVEL`, `SIM_CLOCK`, `ENABLE_DEV_OPS`, `OPS_DEV_TOKEN`,
`SERVICE_VERSION`, `GIT_COMMIT` have defaults. Production refuses to boot with
`ENABLE_DEV_OPS=true`.

`SIM_CLOCK` freezes time for deterministic cut-off demos and tests; the business
date and cut-off are always resolved in `Asia/Dubai`.

## 6. Acceptance tests (this release)

| ID | Test | Where |
|---|---|---|
| S2-T-001 | `/health`, `/ready`, `/version`, `/v1/meta` respond 200 with `mode: sim` | `test/integration/http.test.ts` |
| S2-T-010 | decimal AED parses to exact fils; rejects zero, negatives, >2 decimals | `test/unit/money.test.ts` |
| S2-T-011 | generated UAE IBAN is 23 chars and passes mod-97 | `test/unit/iban.test.ts` |
| S2-T-012 | credit and debit pairs balance; unbalanced is rejected | `test/unit/ledger.test.ts` |
| S2-T-013 | available = book − held − pending; debit cannot go below zero | `test/unit/balance.test.ts` |
| S2-T-014 | canonical request hash is order-independent and route-sensitive | `test/unit/idempotency.test.ts` |
| S2-T-015 | business days, weekends, holidays, cut-off and settlement date | `test/unit/calendar.test.ts` |
| S2-T-016 | legal payout transitions; illegal transitions refused | `test/unit/payout.test.ts` |
| S2-T-020…025 | posting, accumulation, insufficient funds, restricted account, tenant isolation, concurrency | `test/integration/ledger.test.ts` |
| S2-T-026 | HTTP create/list/balance/transactions with a bearer key | `test/integration/http.test.ts` |
| S2-T-027 | ops routes 404 when dev endpoints are disabled | `test/integration/http.test.ts` |
| S2-T-030 | same key + same body replays and posts once | `test/integration/idempotency.test.ts` |
| S2-T-031 | same key + different body returns 409 and changes nothing | `test/integration/idempotency.test.ts` |
| S2-T-032 | writes without a key are refused | `test/integration/idempotency.test.ts` |
| S2-T-033 | five concurrent identical credits post once | `test/integration/idempotency.test.ts` |
| S2-T-034 | a failed attempt is not cached and can be retried | `test/integration/idempotency.test.ts` |
| S2-T-035 | account creation replays instead of opening a second IBAN | `test/integration/idempotency.test.ts` |
| S2-T-040 | payout creation reserves a hold and leaves the ledger untouched | `test/integration/payouts.test.ts` |
| S2-T-041 | settlement posts the debit and captures the hold | `test/integration/payouts.test.ts` |
| S2-T-042 | an illegal transition returns 409 and changes nothing | `test/integration/payouts.test.ts` |
| S2-T-043 | cancel releases the hold | `test/integration/payouts.test.ts` |
| S2-T-044 | hold create/release, replay on release, insufficient funds | `test/integration/payouts.test.ts` |
| S2-T-045 | invalid beneficiary IBAN is refused without reserving funds | `test/integration/payouts.test.ts` |
| S2-T-046 | after cut-off the payout rolls to the next business day | `test/integration/payouts.test.ts` |
| S2-T-047 | reversal posts a credit linked to the settled transaction | `test/integration/payouts.test.ts` |
| S2-T-048 | `payouts:write` is required for payouts | `test/integration/payouts.test.ts` |

## 7. Next packets

`S2-07` statements + EOD, `S2-08` outbox/webhooks, `S2-09` failure scenarios,
`S2-10` ops console, `S2-11` OpenAPI + contract tests, `S2-12` deploy verification,
`S2-13` release.
