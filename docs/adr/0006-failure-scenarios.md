# ADR 0006 — Failure scenarios bend one transition, not the state machine

- Status: accepted
- Date: 2026-11-08
- Packet: `S2-09`

## Context

A demo that only ever succeeds is not a demo of a bank rail. The product has to be
able to show what its UI does when a payout is underpaid, frozen by sanctions, lost
to a timeout, or returned by the beneficiary bank. `S2-09` is the packet that adds
those faults.

The obvious implementation is a second payout lifecycle — `held`, `timed_out`,
`short_paid` — with its own guards. That would double the state machine every later
packet has to reason about: statements, EOD, webhooks and the reconciliation suite
all branch on `payouts.status`.

## Decision

A scenario is a row in `simulator_scenarios`, armed against exactly one payout. When
the payout is asked to make a transition, the armed scenario either:

1. **refuses** the step with a typed error and stays armed (`sanctions_hold` 423,
   `bank_timeout` 504), or
2. **bends** the step (`returned` redirects `submitted → accepted` into
   `submitted → returned`) and is consumed, or
3. **changes the money** of the step (`underpaid` settles `amount − shortfall`) and
   is consumed.

The existing state machine and its legal transitions are unchanged. `underpaid` is
still a `settled` payout; it simply records `settled_amount_minor` and
`failure_code: underpaid`.

## Consequences

- Reconciliation keeps one status vocabulary. A statement, an EOD close and a
  webhook subscriber never need to know a scenario existed; they see a normal
  settlement with a smaller amount, a normal return, or a refused call.
- The scenario row is read `FOR UPDATE` inside the money transaction, so a fault
  cannot fire without the ledger change and cannot fire twice.
- One armed scenario per payout (partial unique index) keeps the outcome
  deterministic; two faults on one payout would make the demo unreproducible.
- A refused step stays armed on purpose: an operator disarms it and retries, which
  is exactly the sanctions-review and timeout-then-retry story.
- `settled_amount_minor` is nullable rather than defaulted because pre-`S2-09`
  payouts have no recorded settled amount; the reversal path falls back to
  `amount_minor`.

## When to revisit

If the product needs a real `held_for_review` status that survives across requests
with its own SLA and reviewer assignment, that belongs in a compliance packet (S7),
not in the simulator's failure-scenario layer.
