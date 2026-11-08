import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  type HoldRecord,
  type PayoutEventRecord,
  type PayoutRecord,
  getPayout,
  listHolds,
  listPayouts,
} from "../../adapters/db/payouts.js";
import { createHoldTx, releaseHoldTx } from "../../application/holds.js";
import { advancePayoutTx, createPayoutTx } from "../../application/payouts.js";
import type { Clock } from "../../config/clock.js";
import type { Env } from "../../config/env.js";
import { MODE } from "../../domain/constants.js";
import { forbidden, notFound } from "../../domain/errors.js";
import { formatAmountMinor, parseAmountMinor } from "../../domain/money.js";
import { PAYOUT_STATUSES } from "../../domain/payout.js";
import { type Principal, authenticate } from "../auth.js";
import { requireIdempotencyKey, withIdempotency } from "../idempotency.js";

export interface PayoutRouteDeps {
  db: Pool;
  env: Env;
  clock: Clock;
}

export function serializeBalance(balance: {
  availableMinor: bigint;
  pendingMinor: bigint;
  heldMinor: bigint;
  ledgerMinor: bigint;
}) {
  return {
    available: formatAmountMinor(balance.availableMinor),
    pending: formatAmountMinor(balance.pendingMinor),
    held: formatAmountMinor(balance.heldMinor),
    ledger: formatAmountMinor(balance.ledgerMinor),
  };
}

export function serializeHold(hold: HoldRecord) {
  return {
    id: hold.id,
    account_id: hold.accountId,
    status: hold.status,
    amount: formatAmountMinor(hold.amountMinor),
    currency: hold.currency,
    reason: hold.reason,
    reference: hold.reference,
    expires_at: hold.expiresAt,
    released_at: hold.releasedAt,
    captured_transaction_id: hold.capturedTransactionId,
    created_at: hold.createdAt,
  };
}

export function serializePayout(payout: PayoutRecord) {
  return {
    id: payout.id,
    account_id: payout.accountId,
    status: payout.status,
    amount: formatAmountMinor(payout.amountMinor),
    currency: payout.currency,
    reference: payout.reference,
    end_to_end_id: payout.endToEndId,
    beneficiary: {
      name: payout.beneficiaryName,
      iban: payout.beneficiaryIban,
      bic: payout.beneficiaryBic,
    },
    hold_id: payout.holdId,
    transaction_id: payout.transactionId,
    settled_amount:
      payout.settledAmountMinor === null ? null : formatAmountMinor(payout.settledAmountMinor),
    scheduled_for: payout.scheduledFor,
    cutoff_at: payout.cutoffAt,
    submitted_at: payout.submittedAt,
    settled_at: payout.settledAt,
    failure_code: payout.failureCode,
    failure_reason: payout.failureReason,
    created_at: payout.createdAt,
    updated_at: payout.updatedAt,
  };
}

function serializeEvents(events: PayoutEventRecord[]) {
  return events.map((event) => ({
    id: event.id,
    from_status: event.fromStatus,
    to_status: event.toStatus,
    actor: event.actor,
    meta: event.meta,
    at: event.at,
  }));
}

function requireScope(principal: Principal, scope: string): void {
  if (!principal.scopes.includes(scope)) {
    throw forbidden(`api key lacks ${scope} scope`);
  }
}

const payoutBody = z.object({
  account_id: z.string().uuid(),
  amount: z.string().min(1),
  currency: z.literal("AED").default("AED"),
  reference: z.string().max(140).optional(),
  end_to_end_id: z.string().max(35).optional(),
  value_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  beneficiary: z.object({
    name: z.string().min(1).max(140),
    iban: z.string().min(5).max(34),
    bic: z.string().min(8).max(11).optional(),
  }),
});

const holdBody = z.object({
  amount: z.string().min(1),
  reason: z.string().min(1).max(140),
  reference: z.string().max(140).optional(),
  expires_at: z.string().datetime({ offset: true }).optional(),
});

const listQuery = z.object({
  status: z.enum(PAYOUT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function registerPayoutRoutes(app: FastifyInstance, deps: PayoutRouteDeps): void {
  const { db, env, clock } = deps;

  app.post("/v1/payouts", async (request, reply) => {
    const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
    requireScope(principal, "payouts:write");

    const body = payoutBody.parse(request.body ?? {});
    const amountMinor = parseAmountMinor(body.amount);
    const key = requireIdempotencyKey(request);

    const result = await withIdempotency(
      {
        db,
        tenantId: principal.tenantId,
        key,
        method: request.method,
        route: request.routeOptions.url ?? request.url,
        body,
      },
      async (client) => {
        const created = await createPayoutTx(client, clock, {
          tenantId: principal.tenantId,
          accountId: body.account_id,
          amountMinor,
          reference: body.reference,
          endToEndId: body.end_to_end_id,
          valueDate: body.value_date,
          beneficiary: body.beneficiary,
          actor: `api_key:${principal.keyId}`,
          requestId: request.id,
        });

        return {
          status: 201,
          body: {
            mode: MODE,
            payout: serializePayout(created.payout),
            balance: created.balance === null ? null : serializeBalance(created.balance),
          },
        };
      },
    );

    if (result.replayed) reply.header("idempotent-replayed", "true");
    return reply.status(result.status).send(result.body);
  });

  app.get("/v1/payouts", async (request) => {
    const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
    requireScope(principal, "payouts:read");

    const query = listQuery.parse(request.query ?? {});
    const payouts = await listPayouts(db, principal.tenantId, {
      status: query.status,
      limit: query.limit,
    });

    return { mode: MODE, data: payouts.map(serializePayout) };
  });

  app.get<{ Params: { id: string } }>("/v1/payouts/:id", async (request) => {
    const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
    requireScope(principal, "payouts:read");

    const found = await getPayout(db, principal.tenantId, request.params.id);
    if (found === null) throw notFound("payout not found");

    return {
      mode: MODE,
      payout: serializePayout(found.payout),
      events: serializeEvents(found.events),
    };
  });

  app.post<{ Params: { id: string } }>("/v1/payouts/:id/cancel", async (request, reply) => {
    const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
    requireScope(principal, "payouts:write");
    const key = requireIdempotencyKey(request);

    const result = await withIdempotency(
      {
        db,
        tenantId: principal.tenantId,
        key,
        method: request.method,
        route: request.routeOptions.url ?? request.url,
        body: {},
      },
      async (client) => {
        const cancelled = await advancePayoutTx(client, {
          clock,
          payoutId: request.params.id,
          to: "cancelled",
          actor: `api_key:${principal.keyId}`,
          requestId: request.id,
        });

        return {
          status: 200,
          body: {
            mode: MODE,
            payout: serializePayout(cancelled.payout),
            balance: cancelled.balance === null ? null : serializeBalance(cancelled.balance),
          },
        };
      },
    );

    if (result.replayed) reply.header("idempotent-replayed", "true");
    return reply.status(result.status).send(result.body);
  });

  app.post<{ Params: { id: string } }>("/v1/accounts/:id/holds", async (request, reply) => {
    const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
    requireScope(principal, "accounts:write");

    const body = holdBody.parse(request.body ?? {});
    const amountMinor = parseAmountMinor(body.amount);
    const key = requireIdempotencyKey(request);

    const result = await withIdempotency(
      {
        db,
        tenantId: principal.tenantId,
        key,
        method: request.method,
        route: request.routeOptions.url ?? request.url,
        body,
      },
      async (client) => {
        const created = await createHoldTx(client, {
          tenantId: principal.tenantId,
          accountId: request.params.id,
          amountMinor,
          reason: body.reason,
          reference: body.reference,
          expiresAt: body.expires_at,
          actor: `api_key:${principal.keyId}`,
          requestId: request.id,
        });

        return {
          status: 201,
          body: {
            mode: MODE,
            hold: serializeHold(created.hold),
            balance: serializeBalance(created.balance),
          },
        };
      },
    );

    if (result.replayed) reply.header("idempotent-replayed", "true");
    return reply.status(result.status).send(result.body);
  });

  app.get<{ Params: { id: string } }>("/v1/accounts/:id/holds", async (request) => {
    const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
    requireScope(principal, "accounts:read");

    const holds = await listHolds(db, principal.tenantId, request.params.id);
    return { mode: MODE, data: holds.map(serializeHold) };
  });

  app.delete<{ Params: { id: string } }>("/v1/holds/:id", async (request, reply) => {
    const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
    requireScope(principal, "accounts:write");
    const key = requireIdempotencyKey(request);

    const result = await withIdempotency(
      {
        db,
        tenantId: principal.tenantId,
        key,
        method: request.method,
        route: request.routeOptions.url ?? request.url,
        body: {},
      },
      async (client) => {
        const released = await releaseHoldTx(client, {
          tenantId: principal.tenantId,
          holdId: request.params.id,
          actor: `api_key:${principal.keyId}`,
          requestId: request.id,
        });

        return {
          status: 200,
          body: {
            mode: MODE,
            hold: serializeHold(released.hold),
            balance: serializeBalance(released.balance),
          },
        };
      },
    );

    if (result.replayed) reply.header("idempotent-replayed", "true");
    return reply.status(result.status).send(result.body);
  });
}
