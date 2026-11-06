# ADR 0001 — Money is bigint minor units

Status: accepted (S2-03, 2026-11-06)

## Context

The ledger must balance exactly. Floats lose precision at the third decimal and
`numeric` is slower and awkward to keep consistent across TypeScript and Postgres.

## Decision

- Store every amount as `bigint` fils (1 AED = 100 fils) in Postgres `bigint` and
  TypeScript `bigint`.
- Accept and return decimal strings at the HTTP edge (`"1250.00"`), parsed by one
  strict function that rejects zero, negatives, more than two decimals, and
  exponent notation.
- Store `currency char(3)` on every amount row even though v1 is AED-only.

## Consequences

- Arithmetic is exact and the balance assertion is a pure `bigint` comparison.
- Postgres returns `int8` as a string, so repositories convert explicitly at the
  mapping boundary; no implicit numeric coercion anywhere.
- Formatting lives in one place (`formatAmountMinor`), so JSON never leaks fils.
