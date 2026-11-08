# S2 — Bank Simulator Specification (v0.5.0-dev.0)

Scope: phases 1–9 (`S2-01`…`S2-09`). This document is the source of truth for what
the simulator must do; `openapi.yaml` and the remaining packets are not built yet.

Live deployment: `https://sim-s2-bank.vercel.app` (Vercel Functions `sin1` + Neon
Postgres `ap-southeast-1`, schema `0005_outbox_webhooks.sql`, dev-ops disabled).

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
- statements for any booking-date range in JSON, CSV and MT940, with
  opening/closing balances that must reconcile with the ledger;
- sequential end-of-day (EOD) close snapshots per account;
- an adjustable simulator clock (`freeze`, `step`, `resume`) for deterministic
  demos and tests;
- a transactional outbox: every money-changing write emits an event in the same
  transaction, with signed webhook delivery, retry/backoff, dead-letter, replay and
  a cursor pull API;
- a double-entry ledger with immutable posted rows;
- tenant resolution from an API key;
- an audit trail for every posting, account opening, hold, payout transition and
  EOD close;
- armed failure scenarios (`underpaid`, `sanctions_hold`, `bank_timeout`,
  `returned`) that bend or refuse exactly one payout transition.

Out of scope: real money, real PII, real bank connectivity, KYB (S3), FX (S9),
cross-border (S10), beneficiary book, ops console (later S2 packets).

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

### 2.2 Statements, EOD and the simulator clock

| Rule | Requirement |
|---|---|
| Statement range | inclusive booking dates; `from <= to`; at most 366 days |
| Opening balance | signed sum of `customer_deposit` entries booked before `from` |
| Closing balance | `opening + credits - debits`, derived in booking-date order |
| Balance after | the statement's own running balance; stored ledger values are advisory |
| Cache integrity | customer ledger and `account_balances.ledger_minor` must agree on every read |
| Statement lines | one per posted transaction, in booking/posting order |
| Formats | JSON, CSV and MT940 are three renderings of the same statement model |
| EOD | one immutable snapshot per account and business date |
| EOD sequence | the next close must be the next UAE business day; no repeats, no skips |
| EOD today | defaults to the current Asia/Dubai business date; future dates are refused |
| Clock | the server may be frozen at an instant and stepped forward; `SIM_CLOCK` starts it frozen |
| Clock exception | `/ops/v1/clock/*` is control-plane and does not take `Idempotency-Key` |

MT940 uses `:20:` reference, `:25:` IBAN, `:28C:` statement/page, `:60F:` opening
balance, `:61:` value date + booking MMDD + `C`/`D` + comma-decimal amount +
`NTRF` + reference, `:86:` narrative, and `:62F:` closing balance. The exact
subfield layout is the simulator's stable contract, not a claim about any one bank.

### 2.3 Outbox, webhooks and event pull

| Rule | Requirement |
|---|---|
| Atomicity | the event row and every delivery row are written in the business transaction |
| Event types | `credit.posted`, `reversal.posted`, `hold.created/released/captured`, `payout.created/validated/submitted/accepted/settled/cancelled/failed/returned`, `eod.closed` |
| Filters | exact type, family (`payout.*`) or `*`; at most 32 filters per subscription |
| URL policy | absolute http(s), no embedded credentials; plain http only for loopback or outside production |
| Signing | `x-sim-signature: t=<unix>,v1=<hex HMAC-SHA256 of ${t}.${body}>` |
| Secret at rest | `whsec_…` encrypted with AES-256-GCM using `WEBHOOK_SECRET_KEY` (or a key derived from `API_KEY_PEPPER`) |
| Delivery | at-least-once, 5s timeout, 2xx = delivered, anything else = failed attempt |
| Retry | exponential backoff `2^attempts` seconds, capped at 300s |
| Dead-letter | after 5 attempts the delivery becomes `dead` and waits for an operator replay |
| Concurrency | due rows are claimed with `FOR UPDATE SKIP LOCKED`; a crash re-queues stale `delivering` rows |
| Pull | `GET /v1/events?after=<seq>` is the cursor alternative to webhooks |
| Tenant scope | subscriptions, deliveries and pulled events are always filtered by the bearer tenant |

The receiver envelope is `{"id","type","created_at","data"}`. `data` is the event
payload; the same bytes are signed, so a receiver can verify before parsing.

### 2.4 Failure scenarios

A scenario is armed against one payout and consumed by the transition it affects.
It never invents a parallel state machine; it bends or refuses one legal step.

| Kind | When it fires | Effect | Arm state |
|---|---|---|---|
| `underpaid` | `accepted → settled` | debit `amount − shortfall`, release the full hold, `settled_amount` and `failure_code: underpaid` recorded | consumed |
| `sanctions_hold` | `→ accepted` or `→ settled` | `423 payment_held`, nothing moves | stays armed |
| `bank_timeout` | `submitted → accepted` | `504 rail_timeout`, payout stays `submitted`, hold stays active | stays armed |
| `returned` | `submitted → accepted` | transition redirected to `submitted → returned`, hold released, ledger untouched | consumed |

Rules:

- At most one armed scenario per payout (partial unique index, `409 scenario_conflict`).
- A scenario cannot be armed on a terminal payout (`settled`, `returned`, `failed`,
  `cancelled`).
- `shortfall` is only valid for `underpaid`; default is 10% of the amount, at least
  one fil, always smaller than the payout.
- The armed row is read `FOR UPDATE` inside the money transaction, so the scenario,
  the ledger change and the outbox event commit together or roll back together.
- `returned` before settlement releases the reserve; returning a settled payout is
  still the separate ops reversal path (`reverse`).

## 3. Data model

`0001_init.sql`: `tenants`, `api_keys`, `accounts`, `account_balances`,
`transactions`, `ledger_entries`, `audit_log`, plus `schema_migrations`.

`0002_idempotency.sql`: `idempotency_keys` keyed by `(tenant_id, key)`, storing
`request_hash`, `route`, `response_status`, `response_body`, and a 24-hour expiry.

`0003_payouts_holds.sql`: `holds`, `payouts`, `payout_events` (append-only).

`0004_statements_eod.sql`: `daily_ledger_entries` (one immutable close snapshot per
account/business date, with opening, closing, credits, debits, line count,
checksum) and `eod_state` (last closed business date per tenant/account).

`0005_outbox_webhooks.sql`: `outbox_events` (monotonic `seq` cursor, typed payload,
`published_at`), `webhook_subscriptions` (URL, encrypted secret, event filters,
status) and `webhook_deliveries` (attempts, `next_retry_at`, last status/error,
signature, unique on `(subscription_id, event_id)`).

`0006_failure_scenarios.sql`: `simulator_scenarios` (tenant, account, payout, kind,
shortfall, `armed`/`consumed`/`disarmed`, one armed row per payout) and
`payouts.settled_amount_minor` (what the beneficiary actually received).

- `accounts.iban` unique, 23-character UAE IBAN (`AE` + check + bank code + 16 digits).
- `ledger_entries.direction` in `D`/`C`; `amount_minor > 0`; `currency = 'AED'`.
- `ledger_entries.balance_after_minor` is stored for the customer leg only.
- `payouts.status` is constrained to the state machine; `scheduled_for` and
  `cutoff_at` are computed at creation.
- `holds.status` in `active`, `released`, `expired`, `captured`.
- `daily_ledger_entries` enforces `closing = opening + credits - debits` in the
  database and is unique on `(account_id, business_date)`.
- `webhook_subscriptions` stores only the encrypted signing secret; the plaintext is
  returned by the create call (and by an exact idempotent replay of it) and never
  by a read.
- `webhook_deliveries` is unique per `(subscription_id, event_id)`, so a retried
  fan-out cannot double-create a delivery.
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
| GET | `/v1/accounts/{id}/statement` | bearer + `accounts:read` | `from`, `to`, `format=json\|csv\|mt940` |
| GET | `/v1/accounts/{id}/statements/{date}/{format}` | bearer + `accounts:read` | daily statement convenience path |
| POST | `/v1/accounts/{id}/eod/close` | bearer + `accounts:write` | close one business date, 201 |
| GET | `/v1/accounts/{id}/eod` | bearer + `accounts:read` | EOD state + recent snapshots |
| GET | `/v1/accounts/{id}/eod/{date}` | bearer + `accounts:read` | one EOD snapshot |
| GET | `/ops/v1/clock` | `x-ops-token` | **dev only** clock state |
| POST | `/ops/v1/clock/freeze` | `x-ops-token` | freeze at `{at}` or now |
| POST | `/ops/v1/clock/step` | `x-ops-token` | step by seconds/minutes/hours/days |
| POST | `/ops/v1/clock/resume` | `x-ops-token` | resume the system clock |
| POST | `/v1/webhooks` | bearer + `webhooks:write` | register a receiver, 201, returns the secret once |
| GET | `/v1/webhooks` | bearer + `webhooks:read` | tenant subscriptions, never the secret |
| DELETE | `/v1/webhooks/{id}` | bearer + `webhooks:write` | disable a subscription |
| GET | `/v1/webhooks/{id}/deliveries` | bearer + `webhooks:read` | delivery attempts and outcomes |
| GET | `/v1/events` | bearer + `events:read` | cursor pull, `after` = last `seq` |
| POST | `/v1/outbox/dispatch` | bearer + `webhooks:write` | drain this tenant's due deliveries |
| POST | `/ops/v1/outbox/dispatch` | `x-ops-token` | **dev only** drain across tenants |
| POST | `/ops/v1/webhooks/deliveries/{id}/replay` | `x-ops-token` | **dev only** re-arm a delivery |
| POST | `/v1/scenarios` | bearer + `payouts:write` | arm a failure scenario on a payout, 201 |
| GET | `/v1/scenarios` | bearer + `payouts:read` | tenant scenarios, newest first |
| DELETE | `/v1/scenarios/{id}` | bearer + `payouts:write` | disarm an armed scenario |
| POST | `/ops/v1/scenarios` | `x-ops-token` | **dev only** arm for any payout |
| GET | `/ops/v1/scenarios` | `x-ops-token` | **dev only** list across tenants |

Conventions: `Authorization: Bearer sk_sim_<prefix>_<secret>`; amounts as strings;
every response contains `"mode":"sim"`; errors are
`{"error":{"code","message","request_id","details"}}`; `x-request-id` is echoed.

Writes: `POST` and `DELETE` require `Idempotency-Key` (1–255 printable ASCII).
Same key + same body replays the stored response with `idempotent-replayed: true`.
Same key + different body or route returns `409 idempotency_conflict`. Failed
requests are not cached. Keys expire after 24 hours. Control-plane ticks are the
exception: `/ops/v1/clock/*` and the two outbox dispatch routes take no key,
because a replay must actually run rather than return a stale summary.

Errors used so far: `validation_error` 400, `unauthorized` 401, `forbidden` 403,
`not_found` 404, `idempotency_conflict` 409, `invalid_state_transition` 409,
`scenario_conflict` 409, `invalid_iban` 422, `invalid_bic` 422, `cutoff_passed` 422,
`amount_out_of_range` 422, `insufficient_funds` 422, `account_restricted` 423,
`payment_held` 423, `internal_error` 500, `rail_timeout` 504.

## 5. Configuration

`DATABASE_URL`, `API_KEY_PEPPER` are required. `API_PORT` (4002), `HOST`,
`NODE_ENV`, `LOG_LEVEL`, `SIM_CLOCK`, `ENABLE_DEV_OPS`, `OPS_DEV_TOKEN`,
`WEBHOOK_SECRET_KEY`, `SERVICE_VERSION`, `GIT_COMMIT` have defaults. Production
refuses to boot with `ENABLE_DEV_OPS=true`.

`WEBHOOK_SECRET_KEY` encrypts stored signing secrets. When it is absent a distinct
key is derived from `API_KEY_PEPPER`; setting it explicitly is recommended for a
deployment so the two purposes do not share material.

`SIM_CLOCK` starts the simulator clock frozen at an instant; the dev ops routes
`/ops/v1/clock/freeze`, `/ops/v1/clock/step` and `/ops/v1/clock/resume` change it
at runtime. The business date and cut-off are always resolved in `Asia/Dubai`.

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
| S2-T-050 | JSON, CSV and MT940 statements agree on opening, closing, credits and debits | `test/integration/statements-eod.test.ts` |
| S2-T-051 | opening/closing carry across a date range and a statement reconciles line by line | `test/unit/statement.test.ts`, integration |
| S2-T-052 | tenant isolation, reversed ranges and >366-day ranges are refused | `test/integration/statements-eod.test.ts` |
| S2-T-053 | EOD closes once, replays with the same key, and refuses repeats and skips | `test/integration/statements-eod.test.ts` |
| S2-T-054 | EOD defaults to the Asia/Dubai business date; weekends are refused | `test/integration/statements-eod.test.ts` |
| S2-T-055 | the ops clock freezes, steps and resumes; business date stays correct | `test/unit/clock.test.ts`, integration |
| S2-T-056 | EOD requires `accounts:write` and an `Idempotency-Key` | `test/integration/statements-eod.test.ts` |
| S2-T-060 | filters match exact types, families and `*`; unknown filters are refused | `test/unit/webhook.test.ts` |
| S2-T-061 | URL policy accepts https and loopback http, refuses credentials and remote http | `test/unit/webhook.test.ts` |
| S2-T-062 | secrets round-trip through AES-256-GCM and fail on the wrong key or tampering | `test/unit/webhook.test.ts` |
| S2-T-063 | `t=<unix>,v1=<hex>` verifies, detects body/secret changes and rejects stale timestamps | `test/unit/webhook.test.ts` |
| S2-T-064 | a credit produces a delivered event whose receiver-verified signature matches | `test/integration/webhooks.test.ts` |
| S2-T-065 | a 5xx retries with backoff and then delivers; a second early tick sends nothing | `test/integration/webhooks.test.ts` |
| S2-T-066 | five failures dead-letter, and an ops replay re-arms and delivers | `test/integration/webhooks.test.ts` |
| S2-T-067 | tenant isolation, invalid URLs/filters, scopes, idempotent registration and write-only secrets | `test/integration/webhooks.test.ts` |
| S2-T-068 | the pull cursor pages events once each and disables delivery on subscription delete | `test/integration/webhooks.test.ts` |

### 6.1 Failure-scenario acceptance tests (`S2-09`)

| ID | Test | Where |
|---|---|---|
| S2-T-060 | underpaid settles `amount − shortfall`, releases the hold and records `settled_amount` | `test/integration/scenarios.test.ts` |
| S2-T-061 | sanctions hold refuses accept and settle with 423 and stays armed | `test/integration/scenarios.test.ts` |
| S2-T-062 | bank timeout refuses accept with 504, payout still `submitted`, hold active | `test/integration/scenarios.test.ts` |
| S2-T-063 | returned redirects accept into `returned` and releases the reserve | `test/integration/scenarios.test.ts` |
| S2-T-064 | one armed scenario per payout; disarm; terminal payouts refuse scenarios | `test/integration/scenarios.test.ts` |
| S2-T-065 | scenario resolution rules, default shortfall and guards | `test/unit/scenario.test.ts` |

## 7. Next packets

`S2-10` ops console, `S2-11` OpenAPI + contract tests, `S2-12` deploy
verification, `S2-13` release.
