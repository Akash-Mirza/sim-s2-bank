# ADR 0005 — Transactional outbox with signed, at-least-once delivery

Status: accepted (S2-08)

## Context

The reconciliation engine needs to learn about money movements without polling a
statement. The tempting shortcut is to `fetch()` the receiver after committing the
ledger change. That loses events when the process dies between commit and send, and
it can send an event for a change that later rolls back. A second shortcut is to
read `transactions` and synthesize events on the fly; then the event contract is
whatever the current query happens to return, and receivers cannot replay history.

## Decision

1. Every money-changing use case writes an `outbox_events` row inside the same
   transaction as the ledger change. If the transaction rolls back, the event never
   existed.
2. Fan-out creates one `webhook_deliveries` row per matching active subscription,
   also in that transaction. The unique `(subscription_id, event_id)` makes fan-out
   idempotent.
3. Delivery is **at-least-once**. A dispatcher claims due rows with
   `FOR UPDATE SKIP LOCKED`, sends outside the claim transaction, and records the
   outcome. Two dispatchers never send the same row at the same time; a crash can
   still re-send after the stale-claim requeue, so receivers must de-duplicate by
   `id`.
4. Signing is HMAC-SHA256 over `${timestamp}.${rawBody}`. The timestamp is inside
   the signed material and verified against a tolerance, so a captured request
   cannot be replayed indefinitely.
5. Signing secrets are generated once, returned at registration (and on an exact
   idempotent replay), and stored AES-256-GCM encrypted. Reads never return them.
6. Failed attempts retry with exponential backoff and become `dead` after
   `max_attempts`. Replay is an explicit operator action, never automatic.
7. Events are also readable through a cursor (`seq`) pull API, so a consumer that
   cannot expose a public URL still gets a complete, ordered history.

## Alternatives rejected

- **Send after commit:** lossy on crash and cannot be ordered with the change.
- **Poll `transactions`:** no stable event contract, no delivery state, no replay.
- **Exactly-once delivery:** requires receiver-side transactions; a simulator
  cannot promise it across an arbitrary HTTP endpoint. At-least-once plus a stable
  event id is the honest contract.

## Consequences

- Receivers must be idempotent and verify signatures before parsing.
- A dispatcher must run. The simulator exposes both a tenant-scoped and an ops
  dispatch route; nothing schedules them yet (a cron or external worker does).
- `outbox_events` grows without bound until a retention policy is added.
- Delivery is in-process and capped at 5 seconds per attempt; a slow receiver is a
  failed attempt, not a stalled request.
