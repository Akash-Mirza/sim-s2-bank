import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { getAccountUnscoped } from "../../adapters/db/accounts.js";
import { getDeliveryUnscoped, requeueDelivery } from "../../adapters/db/outbox.js";
import { getPayoutUnscoped } from "../../adapters/db/payouts.js";
import { dispatchOutbox } from "../../application/outbox.js";
import { advancePayoutTx, reverseSettledPayoutTx } from "../../application/payouts.js";
import { postMovementTx } from "../../application/post-movement.js";
import { armScenarioTx, listEveryScenario } from "../../application/scenarios.js";
import type { AdjustableClock } from "../../config/clock.js";
import type { Env } from "../../config/env.js";
import { MODE } from "../../domain/constants.js";
import { notFound } from "../../domain/errors.js";
import { formatAmountMinor, parseAmountMinor } from "../../domain/money.js";
import { PAYOUT_STATUSES } from "../../domain/payout.js";
import { requireIdempotencyKey, withIdempotency } from "../idempotency.js";
import { registerOpsClockRoutes } from "./ops-clock.js";
import { serializeBalance, serializePayout } from "./payouts.js";
import { scenarioArmBody, scenarioListQuery, serializeScenario } from "./scenarios.js";
import { serializeDelivery } from "./webhooks.js";

export interface OpsRouteDeps {
  db: Pool;
  env: Env;
  clock: AdjustableClock;
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

const dispatchBody = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  tenant_id: z.string().uuid().optional(),
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

  registerOpsClockRoutes(app, { env, clock });

  /**
   * Drain due deliveries across tenants (or one tenant). Like the clock routes this
   * is a control-plane tick and is exempt from Idempotency-Key.
   */
  app.post("/ops/v1/outbox/dispatch", async (request, reply) => {
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

    const body = dispatchBody.parse(request.body ?? {});
    const summary = await dispatchOutbox(
      { db, env },
      { limit: body.limit, tenantId: body.tenant_id },
    );
    return { mode: MODE, dispatch: summary };
  });

  /** Re-arm a dead or failed delivery for another attempt. */
  app.post<{ Params: { id: string } }>(
    "/ops/v1/webhooks/deliveries/:id/replay",
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

      const found = await getDeliveryUnscoped(db, request.params.id);
      if (found === null) throw notFound("webhook delivery not found");
      const key = requireIdempotencyKey(request);

      const result = await withIdempotency(
        {
          db,
          tenantId: found.tenantId,
          key,
          method: request.method,
          route: request.routeOptions.url ?? request.url,
          body: { delivery_id: request.params.id },
        },
        async (client) => {
          const delivery = await requeueDelivery(client, found.tenantId, request.params.id);
          if (delivery === null) throw notFound("webhook delivery not found");
          return {
            status: 200,
            body: { mode: MODE, delivery: serializeDelivery(delivery) },
          };
        },
      );

      if (result.replayed) reply.header("idempotent-replayed", "true");
      return reply.status(result.status).send(result.body);
    },
  );

  /** Arm a failure scenario for any tenant's payout (the console's Scenarios tab). */
  app.post("/ops/v1/scenarios", async (request, reply) => {
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

    const body = scenarioArmBody.parse(request.body ?? {});
    const shortfallMinor =
      body.shortfall === undefined ? undefined : parseAmountMinor(body.shortfall);
    const key = requireIdempotencyKey(request);

    const found = await getPayoutUnscoped(db, body.payout_id);
    if (found === null) throw notFound("payout not found");

    const result = await withIdempotency(
      {
        db,
        tenantId: found.tenantId,
        key,
        method: request.method,
        route: request.routeOptions.url ?? request.url,
        body,
      },
      async (client) => {
        const scenario = await armScenarioTx(client, {
          tenantId: found.tenantId,
          payoutId: found.id,
          kind: body.kind,
          shortfallMinor,
          actor: "ops:dev",
          requestId: request.id,
        });

        return {
          status: 201,
          body: { mode: MODE, scenario: serializeScenario(scenario) },
        };
      },
    );

    if (result.replayed) reply.header("idempotent-replayed", "true");
    return reply.status(result.status).send(result.body);
  });

  app.get("/ops/v1/scenarios", async (request, reply) => {
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

    const query = scenarioListQuery.parse(request.query ?? {});
    const scenarios = await listEveryScenario(db, { status: query.status, limit: query.limit });
    return { mode: MODE, data: scenarios.map(serializeScenario) };
  });
}
