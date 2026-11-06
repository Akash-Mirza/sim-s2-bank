# ADR 0002 — Plain SQL migrations and node-postgres for phases 1–4

Status: accepted (S2-02, 2026-11-06)

## Context

A5 fixes PostgreSQL 16 as the database and proposed Drizzle ORM for typed
queries. The first packets need: a schema, a migration runner, and one hot path
(the posting transaction) that is mostly explicit SQL and row locking.

## Decision

- Migrations are numbered plain `*.sql` files applied by a small runner that
  records each file in `schema_migrations`, one transaction per file.
- Queries use `node-postgres` with explicit SQL and hand-written row mappers.
- Drizzle is not installed in this release.

## Why

- The posting path needs `SELECT … FOR UPDATE`, multi-table inserts, and a
  transactional cache update. Hand-written SQL is the clearest description of
  that, and the reviewer can read it without knowing an ORM's query builder.
- A toolchain-free migration step keeps the compose/CI setup to one command and
  removes a generator from the freeze gate.
- The typed-query benefit is small at this size (7 tables, ~12 queries).

## When to revisit

At `S2-11` (OpenAPI + contract tests) or when the read surface passes ~30
queries, whichever comes first. Replacing the adapter layer with Drizzle is then
a repository change; the schema, migrations, and domain rules do not move.

## Consequences

- Row types are declared next to each repository and mapped explicitly.
- SQL is reviewed as SQL, including constraints and indexes.
- No generated artefacts to keep in sync during the first vertical slices.
