# sim-s2-bank

S2 bank simulator for the BWLCS1 white-label stablecoin case study.

It is a **simulated corporate bank**, not a real bank and not the client portal: a
tenant (the issuer) gets a corporate AED account with a virtual UAE IBAN, a
double-entry ledger in fils, simulated incoming credit, and later statements and
local AED payouts. Every response carries `"mode":"sim"` and the data is
synthetic.

Status: **phases 1–4 of 13 shipped** (`v0.1.0-dev.0`) — scaffold and deploy
contract, schema/migrations/seed, double-entry ledger, accounts and balances.

## Scope delivered so far

| Phase | Packet | What exists |
|---|---|---|
| 1 | `S2-01` | Fastify server, `/health`, `/ready`, `/version`, `/v1/meta`, env validation, Biome, Vitest, Dockerfile, compose, Vercel config, CI |
| 2 | `S2-02` | `0001_init.sql`, numbered migration runner, API key hashing, idempotent seed, guarded reset |
| 3 | `S2-03` | Money as bigint fils, UAE IBAN (mod-97), double-entry pairs, balance rules, atomic posting with row locks and audit |
| 4 | `S2-04` | Accounts, balances, transaction listing, bearer key auth, dev-only ops credit endpoint |

Not built yet: holds, payouts and the payout state machine, statements
(JSON/CSV/MT940), webhooks/outbox, failure scenarios, ops console, OpenAPI, release.

## Run locally

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres
pnpm migrate
pnpm seed          # prints the demo API key once
pnpm dev           # http://localhost:4002
```

Smoke test:

```bash
curl -s localhost:4002/health
curl -s localhost:4002/version
curl -s localhost:4002/v1/accounts -H "Authorization: Bearer <key from seed>"
```

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
├── domain/        pure money, IBAN, ledger, and balance rules (no I/O)
├── application/   use cases: create account, post movement
├── adapters/      Postgres, migrations, crypto
├── http/          routes, auth, error mapping, composition root
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
- Balance cache is updated in the same transaction under `FOR UPDATE`; the ledger
  is the source of truth.
- The tenant comes from the API key, never from the request body.
- No secrets, no real PII, no real bank connectivity.

See `SPEC.md` for the contract, `CHANGELOG.md` for what changed per release, and
`docs/adr/` for why the shape is what it is.
