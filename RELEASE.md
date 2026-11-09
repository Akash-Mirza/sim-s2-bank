# Release v1.0.0 — freeze certificate

- **Release date:** 2026-11-09
- **Version:** `1.0.0` (`package.json`, the `SERVICE_VERSION` default and the OpenAPI
  `info.version` all say `1.0.0`)
- **Scope:** `S2-01` … `S2-13` — 13 of 13 packets, no open S2 work
- **Contract:** 53 routes, `openapi.yaml` generated from `src/contracts/spec.ts`
- **Tag:** `v1.0.0` (annotated, on `main`)
- **Runtime commit deployed:** `0df9a18` (`feat/S2-13-release`); the release
  certificate below lands in the following merge commit, which changes docs only

## Environment of record

| Item | Value |
|---|---|
| App | `sim-s2-bank` — Fastify 5 on Vercel Functions |
| Vercel project | `sim-s2-bank` (team `akashs-projects-246fdc76`), region `sin1` |
| Database | Neon Postgres, `ap-southeast-1`, server `PostgreSQL 18.6` |
| Runtime DSN | Neon **pooled** (`…-pooler…`) `DATABASE_URL` |
| CLI/migration DSN | Neon **direct** host (unpooled) |
| Schema | `0007_ops_sessions.sql`, 20 tables |
| Runtime flags | `NODE_ENV=production`, `ENABLE_DEV_OPS=false`, `SERVICE_VERSION=1.0.0` |
| Live URL | https://sim-s2-bank.vercel.app |

Secrets (`DATABASE_URL`, `API_KEY_PEPPER`, `WEBHOOK_SECRET_KEY`, `OPS_DEV_TOKEN`)
live only in the Vercel project and in the engine's gitignored `.env`. They are
never committed here.

## Freeze statement

`v1.0.0` freezes the S2 contract. From this tag:

- `openapi.yaml` and `src/contracts/api-types.ts` are the published interface;
  `pnpm openapi:check` must stay green in every later commit;
- money, ledger, hold, payout-state, cut-off, statement and EOD rules in `SPEC.md`
  do not change without a new minor or patch version and a new tag;
- the ledger stays append-only: corrections are reversals, never edits.

## Cutover record (what changed in production)

1. Neon migrated from schema `0005` to `0007` (`0006_failure_scenarios.sql`,
   `0007_ops_sessions.sql`).
2. `API_KEY_PEPPER` was rotated for the release. The previous demo key
   (`prefix 33978a2f`) was **revoked** and a new key (`prefix d4b26b09`) was
   issued; the plaintext is held outside the repo (engine `.env` only).
3. The first production operator was created: `ops@sim-s2-bank.dev` (role
   `operator`). The password is held outside the repo.
4. Vercel production env replaced: `DATABASE_URL` (pooled), `API_KEY_PEPPER`,
   `WEBHOOK_SECRET_KEY`, `OPS_DEV_TOKEN`, `SERVICE_VERSION=1.0.0`,
   `GIT_COMMIT=0df9a18`, `NODE_ENV=production`, `ENABLE_DEV_OPS=false`.
5. `v1.0.0` deployed; the live surface was exercised end to end (§Verification).

## Verification matrix — repository gates

| Gate | Command | Result |
|---|---|---|
| Format + lint | `pnpm lint` | 96 files, 0 diagnostics |
| Types | `pnpm typecheck` | 0 errors |
| Unit + contract | `pnpm test` | **93 / 93**, 14 files |
| Integration (real Postgres) | `pnpm test:integration` | **66 / 66**, 9 files — against **Neon PostgreSQL 18.6**, database `sim_s2_test` |
| Build | `pnpm build` | pass |
| Contract drift | `pnpm openapi:check` | current |

The integration suite was executed against Neon, not only local Docker, so the
remote-driver, pooled-latency and clock-skew behaviour is covered. That run
exposed two brittle assumptions, fixed in this release: the 20 s per-test budget
(a network round-trip per query) and a retry assertion that compared a stored
timestamp with `Date.now()` after the read.

## Verification matrix — live production

Every row below was executed against `https://sim-s2-bank.vercel.app` on
2026-11-09.

| Check | Request | Result |
|---|---|---|
| Liveness | `GET /health` | `200 {"status":"ok"}` |
| Readiness | `GET /ready` | `200 {"status":"ready"}` |
| Version | `GET /version` | `1.0.0`, commit `0df9a18`, schema `0007_ops_sessions.sql`, node `v26.13.0` |
| Metadata | `GET /v1/meta` | `200`, four scenario kinds |
| Console page | `GET /ops/console` | `200` HTML |
| No credential | `GET /v1/accounts` | `401` |
| Dev ops token | `x-ops-token` on an ops write | `401` (disabled in production) |
| Ops login | `POST /ops/v1/auth/login` | `200`, `ops_` session, role `operator` |
| Ops session | `GET /ops/v1/auth/me` | `200`, `via: "session"` |
| Ops logout | `POST /ops/v1/auth/logout` then `/auth/me` | `200` then `401` |
| Tenant read | `GET /v1/accounts` with a key | `200`, one AED account `AE17…4750` |
| Simulated credit | `POST /v1/accounts/:id/credits:simulate` `1250.50` | `200`, booking `2026-11-09` |
| Idempotent replay | same request + same `Idempotency-Key` | `200`, `idempotent-replayed: true`, no second posting |
| Payout create | `POST /v1/payouts` `400.00` | `201`, hold `400.00`, `scheduled_for 2026-11-10` (after cut-off) |
| Payout advance | `POST /ops/v1/payouts/:id/advance` ×4 | `validated → submitted → accepted → settled` |
| Settlement | payout read | `settled`, `settled_amount 400.00`, hold released, ledger `4210.50` |
| Failure scenario | arm `underpaid 25.00`, advance ×4 | `settled`, `settled_amount 175.00`, `failure_code underpaid` |
| Statements | JSON / CSV / MT940 for `2026-11-09` | all three reconcile: opening `3360.00`, credits `1250.50`, debits `400.00`, closing `4210.50` |
| EOD close | `POST /v1/accounts/:id/eod/close` `2026-11-09` | `201`, snapshot `checksum d4839258…`, line count 2 |
| EOD replay | same key again | `201`, `idempotent-replayed: true` |
| EOD sequence | close an already-closed date | `409`, allowed `[next business day]` |
| Webhook attempt | subscribe to `https://httpbin.org/status/500`, post a credit, dispatch | claimed 1, delivered 0, failed 1; `last_status_code 500`, signed `x-sim-signature`, retry scheduled |
| Event pull | `GET /v1/events?after=0` | `200`, 18 events, `next_cursor 18` |
| Audit trail | `GET /ops/v1/audit` | `200`, 24 rows, actors `api_key:<id>` and `ops:ops@sim-s2-bank.dev` |
| Final balance | `GET /v1/accounts/:id/balance` | `4135.50` available = ledger, held `0.00` |

## Reproduce this release

```bash
cd apps/sim-s2-bank
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm openapi:check

# migrations + demo key (direct Neon host)
DATABASE_URL='<neon-direct-url>' API_KEY_PEPPER='<pepper>' NODE_ENV=production \
  ENABLE_DEV_OPS=false node dist/cli/migrate.js
pnpm key:issue create --tenant demo-bank-client

# integration suite against a separate test database on the same Neon branch
TEST_DATABASE_URL='<neon-direct-url-with-test-db>' pnpm test:integration

# deploy
vercel --prod --yes
curl -s https://sim-s2-bank.vercel.app/version
```

## Known limits (honest)

- **Live webhook success path not proven against an external receiver.** The live
  proof used a public receiver that deliberately returned 500: the signed attempt,
  the recorded signature, the status code and the retry schedule are real. A
  successful delivery to an external endpoint was not observed in production; the
  success path is covered by `test/integration/webhooks.test.ts` with a real local
  receiver on the Neon test database.
- **No performance or load numbers.** Nothing was timed; cold starts, function
  duration and connection saturation under load are unmeasured.
- **The production data is demo data.** One tenant (`demo-bank-client`), one AED
  account, synthetic movements, no real PII and no bank connectivity.
- **`2026-11-06` was closed before this release** (2026-11-08 verification); this
  release closed `2026-11-09`. That is why the live EOD proof is one date, not a
  full week.
- **The beneficiary book is out of S2 scope** (S10 cross-border), so "100%" means
  13 of 13 S2 packets, not every future product feature.
- **Vercel stores the env values write-only**, so this certificate records names
  and the rotation events, never values.
