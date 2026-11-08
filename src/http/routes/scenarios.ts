import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { ScenarioRecord } from "../../adapters/db/scenarios.js";
import {
  armScenarioTx,
  disarmScenarioTx,
  listTenantScenarios,
} from "../../application/scenarios.js";
import type { Clock } from "../../config/clock.js";
import type { Env } from "../../config/env.js";
import { MODE } from "../../domain/constants.js";
import { forbidden } from "../../domain/errors.js";
import { formatAmountMinor, parseAmountMinor } from "../../domain/money.js";
import { SCENARIO_KINDS, SCENARIO_STATUSES } from "../../domain/scenario.js";
import { type Principal, authenticate } from "../auth.js";
import { requireIdempotencyKey, withIdempotency } from "../idempotency.js";

export interface ScenarioRouteDeps {
  db: Pool;
  env: Env;
  clock: Clock;
}

export const scenarioArmBody = z.object({
  payout_id: z.string().uuid(),
  kind: z.enum(SCENARIO_KINDS),
  shortfall: z.string().min(1).optional(),
});

export const scenarioListQuery = z.object({
  status: z.enum(SCENARIO_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function serializeScenario(scenario: ScenarioRecord) {
  return {
    id: scenario.id,
    tenant_id: scenario.tenantId,
    account_id: scenario.accountId,
    payout_id: scenario.payoutId,
    kind: scenario.kind,
    shortfall_minor: scenario.shortfallMinor?.toString() ?? null,
    shortfall: scenario.shortfallMinor === null ? null : formatAmountMinor(scenario.shortfallMinor),
    status: scenario.status,
    armed_at: scenario.armedAt,
    consumed_at: scenario.consumedAt,
    created_at: scenario.createdAt,
  };
}

function requireScope(principal: Principal, scope: string): void {
  if (!principal.scopes.includes(scope)) {
    throw forbidden(`api key lacks ${scope} scope`);
  }
}

/**
 * Tenant-facing failure scenarios (`S2-09`).
 *
 * A product integrating against S2 can arm a fault for its own payout to prove how
 * its UI and reconciliation behave when the rail misbehaves. The scenario is
 * consumed by the transition it bends, so the demo is repeatable only by arming it
 * again — never by luck.
 */
export function registerScenarioRoutes(app: FastifyInstance, deps: ScenarioRouteDeps): void {
  const { db, env } = deps;

  app.post("/v1/scenarios", async (request, reply) => {
    const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
    requireScope(principal, "payouts:write");

    const body = scenarioArmBody.parse(request.body ?? {});
    const shortfallMinor =
      body.shortfall === undefined ? undefined : parseAmountMinor(body.shortfall);
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
        const scenario = await armScenarioTx(client, {
          tenantId: principal.tenantId,
          payoutId: body.payout_id,
          kind: body.kind,
          shortfallMinor,
          actor: `api_key:${principal.keyId}`,
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

  app.get("/v1/scenarios", async (request) => {
    const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
    requireScope(principal, "payouts:read");

    const query = scenarioListQuery.parse(request.query ?? {});
    const scenarios = await listTenantScenarios(db, principal.tenantId, {
      status: query.status,
      limit: query.limit,
    });

    return { mode: MODE, data: scenarios.map(serializeScenario) };
  });

  app.delete<{ Params: { id: string } }>("/v1/scenarios/:id", async (request, reply) => {
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
        body: { scenario_id: request.params.id },
      },
      async (client) => {
        const scenario = await disarmScenarioTx(client, {
          tenantId: principal.tenantId,
          scenarioId: request.params.id,
          actor: `api_key:${principal.keyId}`,
          requestId: request.id,
        });

        return { status: 200, body: { mode: MODE, scenario: serializeScenario(scenario) } };
      },
    );

    if (result.replayed) reply.header("idempotent-replayed", "true");
    return reply.status(result.status).send(result.body);
  });
}
