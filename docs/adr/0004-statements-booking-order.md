# ADR 0004 — Statements derive balances in booking order

Status: accepted (S2-07)

## Context

`ledger_entries.balance_after_minor` is written in posting order. A statement is
requested by **booking-date range**. When the simulator clock is moved backwards,
or when a historical day is closed after later days already exist, posting order
and booking order can disagree. Using the stored value directly made a valid
historical statement fail its own reconciliation check.

## Decision

1. A statement's opening balance is the signed sum of `customer_deposit` entries
   booked before `from`.
2. Its line balances and closing balance are derived from that opening in
   booking-date order. The statement's `balance_after` is therefore the
   statement's own running balance, not the stored ledger value.
3. Ledger integrity is checked separately: every statement read compares the
   signed sum of all customer ledger entries with
   `account_balances.ledger_minor`. If they disagree, the request fails with
   `internal_error` instead of serving numbers the ledger cannot back.
4. EOD snapshots use the same statement model, so a close and a later statement
   for that date always agree.

## Consequences

- Historical statements stay correct when later bookings already exist.
- The balance cache is still verified on every read; drift is an incident.
- Stored `balance_after_minor` remains useful for posting-order audits, but it is
  not the source of statement balances.
