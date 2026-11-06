import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { getAccountUnscoped } from "../../adapters/db/accounts.js";
import { getPayoutUnscoped } from "../../adapters/db/payouts.js";
import { advancePayoutTx, reverseSettledPayoutTx } from "../../application/payouts.js";
import { postMovementTx } from "../../application/post-movement.js";
import type { Clock } from "../../config/clock.js";
import type { Env } from "../../config/env.js";
import { MODE } from "../../domain/constants.js";
import { notFound } from "../../domain/errors.js";
import { formatAmountMinor, parseAmountMinor } from "../../domain/money.js";
import { PAYOUT_STATUSES } from "../../domain/payout.js";
import { requireIdempotencyKey, withIdempotency } from "../idempotency.js";
import { serializeBalance, serializePayout } from "./payouts.js";

export interface OpsRouteDeps {
  db: Pool;
  env: Env;
  clock: Clock;
}

const simulateCreditBody = z.object({
  amount: z.string().min(1),
  reference: z.string().max(140).optional(),
  value_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  remitter: z
    .object({
      name: z.string().min(1).max(140),
      iban: z.string().min(5).max(34).optional(),
      bic: z.string().min(8).max(11).optional(),
    })
    .optional(),
});

const advanceBody = z.object({
  to: z.enum(PAYOUT_STATUSES).optional(),
});

/**
 * Dev-only ops surface. Real ops session auth and the ops console arrive in S2-10;
 * until then the whole surface is behind ENABLE_DEV_OPS + a shared dev token, and
 * production refuses to boot with it enabled.
 */
export function registerOpsRoutes(app: FastifyInstance, deps: OpsRouteDeps): void {
  const { db, env, clock } = deps;

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/ops/")) return;
    if (!env.enableDevOps) {
      return reply.status(404).send({
        error: { code: "not_found", message: "not found", request_id: request.id, details: null },
      });
    }
  });

  app.post<{ Params: { id: string } }>(
    "/ops/v1/accounts/:id/simulate-credit",
    async (request, reply) => {
      if (request.headers["x-ops-token"] !== env.opsDevToken) {
        return reply.status(401).send({
          error: {
            code: "unauthorized",
            message: "invalid ops token",
            request_id: request.id,
            details: null,
          },
        });
      }

      const body = simulateCreditBody.parse(request.body ?? {});
      const amountMinor = parseAmountMinor(body.amount);
      const key = requireIdempotencyKey(request);

      const found = await getAccountUnscoped(db, request.params.id);
      if (found === null) throw notFound("account not found");

      const result = await withIdempotency(
        {
          db,
          tenantId: found.account.tenantId,
          key,
          method: request.method,
          route: request.routeOptions.url ?? request.url,
          body: { account_id: request.params.id, ...body },
        },
        async (client) => {
          const movement = await postMovementTx(client, clock, {
            tenantId: found.account.tenantId,
            accountId: found.account.id,
            direction: "credit",
            type: "credit_transfer",
            amountMinor,
            reference: body.reference,
            remitter: body.remitter,
            valueDate: body.value_date,
            actor: "ops:dev",
            requestId: request.id,
          });

          return {
            status: 200,
            body: {
              mode: MODE,
              transaction: {
                id: movement.transaction.id,
                type: movement.transaction.type,
                status: movement.transaction.status,
                amount: formatAmountMinor(movement.transaction.amountMinor),
                currency: movement.transaction.currency,
                reference: movement.transaction.reference,
                value_date: movement.transaction.valueDate,
                booking_date: movement.transaction.bookingDate,
              },
              balance: serializeBalance(movement.balance),
            },
          };
        },
      );

      if (result.replayed) reply.header("idempotent-replayed", "true");
      return reply.status(result.status).send(result.body);
    },
  );

  app.post<{ Params: { id: string } }>("/ops/v1/payouts/:id/advance", async (request, reply) => {
    if (request.headers["x-ops-token"] !== env.opsDevToken) {
      return reply.status(401).send({
        error: {
          code: "unauthorized",
          message: "invalid ops token",
          request_id: request.id,
          details: null,
        },
      });
    }

    const body = advanceBody.parse(request.body ?? {});
    const key = requireIdempotencyKey(request);

    const found = await getPayoutUnscoped(db, request.params.id);
    if (found === null) throw notFound("payout not found");

    const result = await withIdempotency(
      {
        db,
        tenantId: found.tenantId,
        key,
        method: request.method,
        route: request.routeOptions.url ?? request.url,
        body: { payout_id: request.params.id, ...body },
      },
      async (client) => {
        const advanced = await advancePayoutTx(client, {
          clock,
          payoutId: request.params.id,
          to: body.to,
          actor: "ops:dev",
          requestId: request.id,
        });

        return {
          status: 200,
          body: {
            mode: MODE,
            payout: serializePayout(advanced.payout),
            events: advanced.events,
            balance: advanced.balance === null ? null : serializeBalance(advanced.balance),
          },
        };
      },
    );

    if (result.replayed) reply.header("idempotent-replayed", "true");
    return reply.status(result.status).send(result.body);
  });

  app.post<{ Params: { id: string } }>("/ops/v1/payouts/:id/reverse", async (request, reply) => {
    if (request.headers["x-ops-token"] !== env.opsDevToken) {
      return reply.status(401).send({
        error: {
          code: "unauthorized",
          message: "invalid ops token",
          request_id: request.id,
          details: null,
        },
      });
    }

    const key = requireIdempotencyKey(request);

    const found = await getPayoutUnscoped(db, request.params.id);
    if (found === null) throw notFound("payout not found");

    const result = await withIdempotency(
      {
        db,
        tenantId: found.tenantId,
        key,
        method: request.method,
        route: request.routeOptions.url ?? request.url,
        body: { payout_id: request.params.id },
      },
      async (client) => {
        const reversed = await reverseSettledPayoutTx(client, {
          clock,
          payoutId: request.params.id,
          actor: "ops:dev",
          requestId: request.id,
        });

        return {
          status: 200,
          body: {
            mode: MODE,
            payout: serializePayout(reversed.payout),
            events: reversed.events,
            balance: reversed.balance === null ? null : serializeBalance(reversed.balance),
          },
        };
      },
    );

    if (result.replayed) reply.header("idempotent-replayed", "true");
    return reply.status(result.status).send(result.body);
  });
}
