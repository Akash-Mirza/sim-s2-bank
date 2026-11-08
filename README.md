# sim-s2-bank

S2 bank simulator for the BWLCS1 white-label stablecoin case study.

It is a **simulated corporate bank**, not a real bank and not the client portal: a
tenant (the issuer) gets a corporate AED account with a virtual UAE IBAN, a
double-entry ledger in fils, simulated incoming credit, replay-safe writes, holds,
local AED payouts with a UAE cut-off, statements, and signed webhooks. Every
response carries `"mode":"sim"` and the data is synthetic.

Status: **phases 1–11 of 13 shipped** (`v0.7.0-dev.0`) — scaffold and deploy
contract, schema/migrations/seed, double-entry ledger, accounts and balances,
idempotency, holds and payouts, statements/EOD and the adjustable ops clock, the
transactional outbox with signed webhook delivery, armed failure scenarios, the ops
console with real session auth, and the generated OpenAPI contract with contract
tests.

Production demo: **https://sim-s2-bank.vercel.app** (Vercel Functions in `sin1`,
Neon Postgres in `ap-southeast-1`, dev-ops routes disabled).

## Scope delivered so far

| Phase | Packet | What exists |
|---|---|---|
| 1 | `S2-01` | Fastify server, `/health`, `/ready`, `/version`, `/v1/meta`, env validation, Biome, Vitest, Dockerfile, compose, Vercel config, CI |
| 2 | `S2-02` | `0001_init.sql`, numbered migration runner, API key hashing, idempotent seed, guarded reset |
| 3 | `S2-03` | Money as bigint fils, UAE IBAN (mod-97), double-entry pairs, balance rules, atomic posting with row locks and audit |
| 4 | `S2-04` | Accounts, balances, transaction listing, bearer key auth, dev-only ops credit endpoint |
| 5 | `S2-05` | `Idempotency-Key` enforced on all writes; key row commits with the money; replay, 409 conflict, concurrency |
| 6 | `S2-06` | Holds (reserve/release/capture), payouts with the ten-state machine, UAE business calendar + 15:00 cut-off, ops advance/reverse |
| 7 | `S2-07` | Statements (JSON/CSV/MT940) for any booking-date range, sequential EOD snapshots, adjustable ops clock (freeze/step/resume) |
| 8 | `S2-08` | Transactional outbox, webhook subscriptions, HMAC-signed at-least-once delivery, retry/backoff, dead-letter, ops replay, event pull cursor |
| 9 | `S2-09` | Failure scenarios: underpaid settlement, sanctions hold, rail timeout, return before settlement; tenant and ops scenario routes |
| 10 | `S2-10` | Ops users (scrypt), sessions with roles (viewer/operator/admin), session guard replacing the dev token in production, and the `/ops/console` UI |
| 11 | `S2-11` | Contract as code: 53-route table, generated `openapi.yaml` and `api-types.ts`, contract tests for route parity, idempotency coverage and drift |

Not built yet: beneficiary book, deploy verification, release.

## Run locally

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres
pnpm migrate
pnpm seed          # prints the demo API key once
pnpm dev           # http://localhost:4002
```

Smoke test (every write needs an idempotency key):

```bash
curl -s localhost:4002/health
curl -s localhost:4002/version
curl -s localhost:4002/v1/accounts -H "Authorization: Bearer <key from seed>"

# simulate a credit
curl -s -X POST localhost:4002/v1/accounts/<account>/credits:simulate \
  -H "Authorization: Bearer <key>" -H 'content-type: application/json' \
  -H 'Idempotency-Key: dep-2026-000123' \
  -d '{"amount":"1250.00","reference":"DEP-2026-000123"}'

# create a payout, then walk it to settled (ops is dev-only)
curl -s -X POST localhost:4002/v1/payouts \
  -H "Authorization: Bearer <key>" -H 'content-type: application/json' \
  -H 'Idempotency-Key: pay-2026-000456' \
  -d '{"account_id":"<account>","amount":"400.00","reference":"INV-2026-0042",
       "beneficiary":{"name":"GULF SUPPLIES LLC","iban":"<valid UAE IBAN>","bic":"EBILAEAD"}}'

curl -s -X POST localhost:4002/ops/v1/payouts/<payout>/advance \
  -H "x-ops-token: dev-ops-token" -H 'Idempotency-Key: adv-1' -d '{}'

# statements: the same day in three formats
curl -s "localhost:4002/v1/accounts/<account>/statement?from=2026-11-05&to=2026-11-05"
curl -s "localhost:4002/v1/accounts/<account>/statements/2026-11-05/csv"
curl -s "localhost:4002/v1/accounts/<account>/statements/2026-11-05/mt940"

# close the day, then read the snapshot
curl -s -X POST localhost:4002/v1/accounts/<account>/eod/close \
  -H "Authorization: Bearer <key>" -H 'content-type: application/json' \
  -H 'Idempotency-Key: eod-2026-11-05' -d '{"business_date":"2026-11-05"}'
curl -s localhost:4002/v1/accounts/<account>/eod -H "Authorization: Bearer <key>"

# move the simulator clock (dev only)
curl -s -X POST localhost:4002/ops/v1/clock/freeze -H 'x-ops-token: dev-ops-token' \
  -H 'content-type: application/json' -d '{"at":"2026-11-05T08:00:00.000Z"}'
curl -s -X POST localhost:4002/ops/v1/clock/step -H 'x-ops-token: dev-ops-token' \
  -H 'content-type: application/json' -d '{"days":1}'

# register a webhook receiver (returns the signing secret once)
curl -s -X POST localhost:4002/v1/webhooks \
  -H "Authorization: Bearer <key>" -H 'content-type: application/json' \
  -H 'Idempotency-Key: hook-1' \
  -d '{"url":"http://localhost:9100/hook","events":["credit.posted","payout.*"]}'

# drain due deliveries, then inspect them
curl -s -X POST localhost:4002/v1/outbox/dispatch -H "Authorization: Bearer <key>" -d '{}'
curl -s localhost:4002/v1/webhooks/<subscription>/deliveries -H "Authorization: Bearer <key>"

# or pull events instead of receiving them
curl -s "localhost:4002/v1/events?after=0&limit=50" -H "Authorization: Bearer <key>"

# arm a failure scenario on a payout, then advance it into the fault
curl -s -X POST localhost:4002/v1/scenarios \
  -H "Authorization: Bearer <key>" -H 'content-type: application/json' \
  -H 'Idempotency-Key: scenario-1' \
  -d '{"payout_id":"<payout>","kind":"underpaid","shortfall":"25.00"}'
curl -s localhost:4002/v1/scenarios -H "Authorization: Bearer <key>"
# underpaid -> settled with settled_amount 225.00
# sanctions_hold -> 423 payment_held; bank_timeout -> 504 rail_timeout
# returned -> the payout becomes returned and the hold is released
```

A receiver gets `x-sim-signature: t=<unix>,v1=<hex>`, where the hex is
`HMAC-SHA256(secret, "${t}.${rawBody}")`. Verify it before parsing, reject a
timestamp outside your tolerance (the simulator signs 5 minutes either side), and
treat delivery as at-least-once: the same event id can arrive more than once after
a retry or replay.

After cut-off (15:00 GST) a payout without a `value_date` is scheduled for the next
business day; asking for same-day settlement after the cut-off returns
`422 cutoff_passed`.

## Ops console

The console is served by the API itself at `http://localhost:4002/ops/console`. It
logs in against `/ops/v1/auth/login` and keeps the `ops_` token in session storage;
every tab calls the same `/ops/v1` routes the CLI uses.

```bash
# create the first operator (password never printed, scrypt-hashed in the DB)
pnpm ops:user create --email ops@example.com --name "Ops" --role operator \
  --password 'a-long-dev-password'
pnpm ops:user list

# or get a token by hand
curl -s -X POST localhost:4002/ops/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"ops@example.com","password":"a-long-dev-password"}'
curl -s localhost:4002/ops/v1/accounts -H "Authorization: Bearer ops_..."
```

Roles: `viewer` reads, `operator` reads and writes, `admin` also manages users.
The shared `x-ops-token` still works locally while `ENABLE_DEV_OPS=true`; production
refuses that flag, so a deployed simulator is session-only.

## Deploy (Vercel + Neon)

The production deployment is one Vercel Function (`api/index.ts` rewrites every
path through Fastify) and a Neon Postgres database. `vercel.json` disables
framework detection so Vercel uses that handler instead of its Fastify entrypoint
scan, and pins functions to `sin1`.

```bash
# 1. apply migrations to the production database (direct, unpooled URL)
DATABASE_URL='<neon-direct-url>' API_KEY_PEPPER='<32+ bytes>' \
  NODE_ENV=production ENABLE_DEV_OPS=false node dist/cli/migrate.js

# 2. seed the demo tenant once; it prints the API key exactly once
DATABASE_URL='<neon-direct-url>' API_KEY_PEPPER='<same pepper>' \
  NODE_ENV=production ENABLE_DEV_OPS=false node dist/cli/seed.js

# 3. deploy; set the same API_KEY_PEPPER, WEBHOOK_SECRET_KEY, OPS_DEV_TOKEN,
#    DATABASE_URL (pooled), ENABLE_DEV_OPS=false and SERVICE_VERSION in Vercel
vercel --prod
```

Use the pooled connection string for `DATABASE_URL`; use the direct URL only for
migrations and seeding. `ENABLE_DEV_OPS=true` is rejected at boot when
`NODE_ENV=production`.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm test                 # unit + contract tests, no database
pnpm test:contract        # contract tests only
pnpm test:integration     # needs TEST_DATABASE_URL
pnpm openapi              # regenerate openapi.yaml + src/contracts/api-types.ts
pnpm openapi:check        # fail when the generated contract is stale
```

The contract is code: `src/contracts/spec.ts` is the source of truth, and
`pnpm openapi` derives `openapi.yaml` and `src/contracts/api-types.ts` from it. A
route that is missing from the table (or declared but not registered) fails
`pnpm test`.

Integration tests refuse to run without `TEST_DATABASE_URL` and refuse a URL that
does not look like a test database.

```bash
docker compose up -d postgres
docker exec -it sim-s2-bank-postgres-1 createdb -U sim_s2 sim_s2_test
TEST_DATABASE_URL=postgres://sim_s2:sim_s2@localhost:5435/sim_s2_test pnpm test:integration
```

## Layout

```text
src/
├── domain/        pure money, IBAN, ledger, balance, calendar, payout, statement, EOD, webhook, scenario rules
├── application/   use cases: accounts, postings, holds, payouts, statements, EOD, outbox
├── adapters/      Postgres, migrations, crypto (API keys, webhook secrets/HMAC)
├── http/          routes (tenant, ops, console), auth, ops sessions, idempotency, errors
├── config/        env validation, adjustable clock
├── cli/           migrate, seed, reset, ops-user, openapi (built into dist for compose)
└── contracts/     route table + schemas (source of truth), YAML/TS codegen
migrations/        numbered plain SQL
openapi.yaml       generated contract (do not edit)
test/unit          fast rules tests
test/integration   real Postgres tests (webhooks use a real local receiver)
api/index.ts       Vercel Node handler
public/            empty static output for the functions-only Vercel build
vercel.json        Vercel build, rewrite and function-region config
```

## Rules this repo follows

- Money is `bigint` fils. Never floats.
- Every movement is a balanced double-entry pair; unbalanced is rejected.
- Posted rows are immutable; corrections are reversals.
- A hold changes available, never the ledger; settlement captures it atomically.
- Every write takes `Idempotency-Key`; the key row commits with the change.
- Payout transitions are a closed state machine; illegal moves are `409`.
- A statement is one model rendered three ways; it must reconcile line by line.
- EOD is sequential: no repeats, no skipped business days.
- An event is written in the same transaction as the money it describes.
- Webhook delivery is at-least-once and signed; retries are bounded, then dead-lettered.
- A failure scenario bends or refuses one existing payout transition; it never adds a parallel state.
- The tenant comes from the API key, never from the request body.
- An ops action names a person (`ops:<email>`) and a role; the shared dev token is local only.
- The contract is generated from code and verified by a test; a route without a spec entry cannot ship.
- No secrets, no real PII, no real bank connectivity.

See `SPEC.md` for the contract, `CHANGELOG.md` for what changed per release, and
`docs/adr/` for why the shape is what it is.
