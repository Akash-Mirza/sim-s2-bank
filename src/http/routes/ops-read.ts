import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { listAccountsUnscoped } from "../../adapters/db/accounts.js";
import { listRecentAudit, listRecentDeliveries } from "../../adapters/db/ops.js";
import { listPayoutsUnscoped } from "../../adapters/db/payouts.js";
import type { Env } from "../../config/env.js";
import { MODE } from "../../domain/constants.js";
import { PAYOUT_STATUSES } from "../../domain/payout.js";
import { requireOps } from "../ops-auth.js";
import { serializeAccount } from "./accounts.js";
import { serializeBalance, serializePayout } from "./payouts.js";

export interface OpsReadRouteDeps {
  db: Pool;
  env: Env;
}

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const payoutQuery = z.object({
  status: z.enum(PAYOUT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * Read-only ops views. These exist for the console (`S2-10`): an operator has to
 * see every tenant's accounts, payouts, deliveries and audit rows without holding
 * a tenant API key. Every route is session-guarded.
 */
export function registerOpsReadRoutes(app: FastifyInstance, deps: OpsReadRouteDeps): void {
  app.get("/ops/v1/accounts", async (request) => {
    await requireOps(deps, request);
    const query = listQuery.parse(request.query ?? {});
    const accounts = await listAccountsUnscoped(deps.db, query.limit);

    return {
      mode: MODE,
      data: accounts.map(({ account, balance }) => ({
        ...serializeAccount(account),
        tenant_id: account.tenantId,
        balance: serializeBalance(balance),
      })),
    };
  });

  app.get("/ops/v1/payouts", async (request) => {
    await requireOps(deps, request);
    const query = payoutQuery.parse(request.query ?? {});
    const payouts = await listPayoutsUnscoped(deps.db, query);
    return { mode: MODE, data: payouts.map(serializePayout) };
  });

  app.get("/ops/v1/audit", async (request) => {
    await requireOps(deps, request);
    const query = listQuery.parse(request.query ?? {});
    const entries = await listRecentAudit(deps.db, query.limit);

    return {
      mode: MODE,
      data: entries.map((entry) => ({
        id: entry.id,
        tenant_id: entry.tenantId,
        actor: entry.actor,
        action: entry.action,
        entity_type: entry.entityType,
        entity_id: entry.entityId,
        before: entry.before,
        after: entry.after,
        request_id: entry.requestId,
        at: entry.at,
      })),
    };
  });

  app.get("/ops/v1/webhooks/deliveries", async (request) => {
    await requireOps(deps, request);
    const query = listQuery.parse(request.query ?? {});
    const deliveries = await listRecentDeliveries(deps.db, query.limit);

    return {
      mode: MODE,
      data: deliveries.map((delivery) => ({
        id: delivery.id,
        tenant_id: delivery.tenantId,
        subscription_id: delivery.subscriptionId,
        event_id: delivery.eventId,
        status: delivery.status,
        attempts: delivery.attempts,
        last_status_code: delivery.lastStatusCode,
        next_retry_at: delivery.nextRetryAt,
        created_at: delivery.createdAt,
      })),
    };
  });
}
