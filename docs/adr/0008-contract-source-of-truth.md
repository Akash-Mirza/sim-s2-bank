# ADR 0008 — The contract is TypeScript; `openapi.yaml` and the types are generated

- Status: accepted
- Date: 2026-11-08
- Packet: `S2-11`

## Context

`S2-11` needs three things that can easily drift apart: an OpenAPI document the
product team can generate a client from, TypeScript types for the same payloads, and
tests that prove the document matches what the server actually serves. `A9` noted
there was no `openapi.yaml`; `A11` noted `schema_version` was `null` and MT940 was
never contract-tested.

The usual failure mode is a hand-written `openapi.yaml` that describes the API as it
was two packets ago. Nothing in the build notices, and the product's generated client
breaks in a demo.

## Decision

1. **One source of truth in code.** `src/contracts/spec.ts` holds a typed route table
   (`method`, `path`, `operationId`, auth, scope, request schema, success schema,
   extra errors) and the component schemas, written in a deliberately small JSON
   Schema subset.
2. **Generated artifacts are committed.** `pnpm openapi` writes `openapi.yaml` and
   `src/contracts/api-types.ts`. A small dependency-free YAML emitter and a
   JSON-Schema-subset-to-TypeScript renderer do the work; no OpenAPI toolchain is
   added to the runtime.
3. **Drift is a test failure, not a review note.** `test/contract/spec.test.ts`
   compares all four things:
   - the route table against the routes Fastify actually registers (via the
     `onRoute` hook added to `buildServer`);
   - every write against the `Idempotency-Key` rule, with the control-plane
     exemption list pinned;
   - `openapi.yaml` on disk against the generator output;
   - `api-types.ts` on disk against the generator output.
4. **Runtime shape is checked too.** The contract test asserts the documented error
   envelope (`error.code`, `error.message`, `error.request_id`, `error.details`) and
   the `x-request-id` echo from a real injected request, so the document is not only
   structurally consistent but behaviourally anchored.

## Consequences

- Adding a route without declaring it fails the contract test; declaring a route the
  server does not register fails too.
- The product team can generate a client from `openapi.yaml` and trust that the
  routes, scopes and idempotency requirements match the running code.
- The schema subset is intentionally small (flat objects, arrays, enums, nullable).
  A component that needs `oneOf`, discriminators or recursive types must extend
  `JsonSchema` and the renderer first. That is a feature: it keeps the generated
  types readable.
- `openapi.yaml` is not linted by an external validator; the tests check structure
  and parity, not every OpenAPI rule. Adding a validator is a one-command change in
  a later packet if a consumer needs it.
- The contract describes payloads, not response bodies byte-for-byte: statement
  responses advertise their content types but their bodies are generated views, so
  the contract test covers route/status/envelope shape rather than field values.

## When to revisit

When a consumer needs a generated SDK in a second language, or when the schema grows
past what the subset can express, replace the hand-rolled renderer with
`openapi-typescript` and a validator. The route table stays the source of truth.
