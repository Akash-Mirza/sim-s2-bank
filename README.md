# sim-s2-bank

S2 bank simulator for the BWLCS1 white-label stablecoin case study.

It is a **simulated corporate bank**, not a real bank and not the client portal: a
tenant (the issuer) gets a corporate AED account with a virtual UAE IBAN, a
double-entry ledger in fils, simulated incoming credit, replay-safe writes, holds,
and local AED payouts with a UAE cut-off. Every response carries `"mode":"sim"` and
the data is synthetic.

Status: **phases 1–6 of 13 shipped** (`v0.2.0-dev.0`) — scaffold and deploy
contract, schema/migrations/seed, double-entry ledger, accounts and balances,
idempotency, holds and payouts.

## Scope delivered so far

| Phase | Packet | What exists |
|---|---|---|
| 1 | `S2-01` | Fastify server, `/health`, `/ready`, `/version`, `/v1/meta`, env validation, Biome, Vitest, Dockerfile, compose, Vercel config, CI |
| 2 | `S2-02` | `0001_init.sql`, numbered migration runner, API key hashing, idempotent seed, guarded reset |
| 3 | `S2-03` | Money as bigint fils, UAE IBAN (mod-97), double-entry pairs, balance rules, atomic posting with row locks and audit |
| 4 | `S2-04` | Accounts, balances, transaction listing, bearer key auth, dev-only ops credit endpoint |
| 5 | `S2-05` | `Idempotency-Key` enforced on all writes; key row commits with the money; replay, 409 conflict, concurrency |
| 6 | `S2-06` | Holds (reserve/release/capture), payouts with the ten-state machine, UAE business calendar + 15:00 cut-off, ops advance/reverse |

Not built yet: statements (JSON/CSV/MT940), webhooks/outbox, failure scenarios,
beneficiary book, ops console, OpenAPI, live deploy, release.

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
```

After cut-off (15:00 GST) a payout without a `value_date` is scheduled for the next
business day; asking for same-day settlement after the cut-off returns
`422 cutoff_passed`.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm test                 # unit only, no database
pnpm test:integration     # needs TEST_DATABASE_URL
```

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
├── domain/        pure money, IBAN, ledger, balance, calendar, payout rules
├── application/   use cases: accounts, postings, holds, payouts
├── adapters/      Postgres, migrations, crypto
├── http/          routes, auth, idempotency, error mapping, composition root
├── config/        env validation, clock
└── cli/           migrate, seed, reset (built into dist for compose)
migrations/        numbered plain SQL
test/unit          fast rules tests
test/integration   real Postgres tests
api/index.ts       Vercel Node handler
```

## Rules this repo follows

- Money is `bigint` fils. Never floats.
- Every movement is a balanced double-entry pair; unbalanced is rejected.
- Posted rows are immutable; corrections are reversals.
- A hold changes available, never the ledger; settlement captures it atomically.
- Every write takes `Idempotency-Key`; the key row commits with the change.
- Payout transitions are a closed state machine; illegal moves are `409`.
- The tenant comes from the API key, never from the request body.
- No secrets, no real PII, no real bank connectivity.

See `SPEC.md` for the contract, `CHANGELOG.md` for what changed per release, and
`docs/adr/` for why the shape is what it is.
