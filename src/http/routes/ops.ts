import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { getAccountUnscoped } from "../../adapters/db/accounts.js";
import { postMovement } from "../../application/post-movement.js";
import type { Clock } from "../../config/clock.js";
import type { Env } from "../../config/env.js";
import { MODE } from "../../domain/constants.js";
import { notFound } from "../../domain/errors.js";
import { formatAmountMinor, parseAmountMinor } from "../../domain/money.js";

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
      const found = await getAccountUnscoped(db, request.params.id);
      if (found === null) throw notFound("account not found");

      const result = await postMovement(
        { db, clock },
        {
          tenantId: found.account.tenantId,
          accountId: found.account.id,
          direction: "credit",
          type: "credit_transfer",
          amountMinor: parseAmountMinor(body.amount),
          reference: body.reference,
          remitter: body.remitter,
          valueDate: body.value_date,
          actor: "ops:dev",
          requestId: request.id,
        },
      );

      return {
        mode: MODE,
        transaction: {
          id: result.transaction.id,
          type: result.transaction.type,
          status: result.transaction.status,
          amount: formatAmountMinor(result.transaction.amountMinor),
          currency: result.transaction.currency,
          reference: result.transaction.reference,
          value_date: result.transaction.valueDate,
          booking_date: result.transaction.bookingDate,
        },
        balance: {
          available: formatAmountMinor(result.balance.availableMinor),
          pending: formatAmountMinor(result.balance.pendingMinor),
          held: formatAmountMinor(result.balance.heldMinor),
          ledger: formatAmountMinor(result.balance.ledgerMinor),
        },
      };
    },
  );
}
