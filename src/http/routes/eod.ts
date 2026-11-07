import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { DailyLedgerEntryRecord } from "../../adapters/db/statements.js";
import { closeEodTx, getEodEntry, getEodSummary } from "../../application/eod.js";
import type { Clock } from "../../config/clock.js";
import type { Env } from "../../config/env.js";
import { forbidden, notFound } from "../../domain/errors.js";
import { formatAmountMinor } from "../../domain/money.js";
import { renderStatementJson } from "../../domain/statement.js";
import { type Principal, authenticate } from "../auth.js";
import { requireIdempotencyKey, withIdempotency } from "../idempotency.js";

export interface EodRouteDeps {
  db: Pool;
  env: Env;
  clock: Clock;
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const closeBody = z.object({
  business_date: z.string().regex(datePattern, "business_date must be YYYY-MM-DD").optional(),
});

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const dateParams = z.object({
  id: z.string().uuid(),
  date: z.string().regex(datePattern, "date must be YYYY-MM-DD"),
});

function requireScope(principal: Principal, scope: string): void {
  if (!principal.scopes.includes(scope)) {
    throw forbidden(`api key lacks ${scope} scope`);
  }
}

export function serializeEodEntry(entry: DailyLedgerEntryRecord) {
  return {
    id: entry.id,
    account_id: entry.accountId,
    business_date: entry.businessDate,
    status: entry.status,
    opening_balance: formatAmountMinor(entry.openingMinor),
    closing_balance: formatAmountMinor(entry.closingMinor),
    credits: formatAmountMinor(entry.creditsMinor),
    debits: formatAmountMinor(entry.debitsMinor),
    line_count: entry.lineCount,
    checksum: entry.checksum,
    closed_at: entry.closedAt,
    closed_by: entry.closedBy,
  };
}

export function registerEodRoutes(app: FastifyInstance, deps: EodRouteDeps): void {
  const { db, env, clock } = deps;

  /**
   * Close one business date. EOD is sequential, so the next legal date is the next
   * UAE business day; the default is today in Asia/Dubai.
   */
  app.post<{ Params: { id: string } }>("/v1/accounts/:id/eod/close", async (request, reply) => {
    const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
    requireScope(principal, "accounts:write");

    const body = closeBody.parse(request.body ?? {});
    const key = requireIdempotencyKey(request);

    const result = await withIdempotency(
      {
        db,
        tenantId: principal.tenantId,
        key,
        method: request.method,
        route: request.routeOptions.url ?? request.url,
        body: { account_id: request.params.id, ...body },
      },
      async (client) => {
        const closed = await closeEodTx(client, clock, {
          tenantId: principal.tenantId,
          accountId: request.params.id,
          businessDate: body.business_date,
          actor: `api_key:${principal.keyId}`,
          requestId: request.id,
        });

        return {
          status: 201,
          body: {
            mode: "sim",
            eod: serializeEodEntry(closed.entry),
            statement: renderStatementJson(closed.statement),
            last_closed_business_date: closed.state.lastClosedBusinessDate,
          },
        };
      },
    );

    if (result.replayed) reply.header("idempotent-replayed", "true");
    return reply.status(result.status).send(result.body);
  });

  app.get<{ Params: { id: string } }>("/v1/accounts/:id/eod", async (request) => {
    const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
    requireScope(principal, "accounts:read");

    const query = listQuery.parse(request.query ?? {});
    const summary = await getEodSummary(db, principal.tenantId, request.params.id, query.limit);

    return {
      mode: "sim",
      account_id: request.params.id,
      last_closed_business_date: summary.state?.lastClosedBusinessDate ?? null,
      data: summary.entries.map(serializeEodEntry),
    };
  });

  app.get<{ Params: { id: string; date: string } }>(
    "/v1/accounts/:id/eod/:date",
    async (request) => {
      const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
      requireScope(principal, "accounts:read");

      const params = dateParams.parse(request.params);
      const entry = await getEodEntry(db, principal.tenantId, params.id, params.date);
      if (entry === null) throw notFound("EOD snapshot not found");
      return { mode: "sim", eod: serializeEodEntry(entry) };
    },
  );
}
