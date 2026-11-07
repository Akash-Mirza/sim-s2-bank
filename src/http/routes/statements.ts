import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { loadStatement } from "../../application/statements.js";
import type { Clock } from "../../config/clock.js";
import { businessDate } from "../../config/clock.js";
import type { Env } from "../../config/env.js";
import { forbidden } from "../../domain/errors.js";
import {
  STATEMENT_FORMATS,
  type StatementFormat,
  renderStatementCsv,
  renderStatementJson,
  renderStatementMt940,
} from "../../domain/statement.js";
import { type Principal, authenticate } from "../auth.js";

export interface StatementRouteDeps {
  db: Pool;
  env: Env;
  clock: Clock;
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const statementQuery = z.object({
  from: z.string().regex(datePattern, "from must be YYYY-MM-DD").optional(),
  to: z.string().regex(datePattern, "to must be YYYY-MM-DD").optional(),
  format: z.enum(STATEMENT_FORMATS).default("json"),
});

const pathParams = z.object({
  id: z.string().uuid(),
  date: z.string().regex(datePattern, "date must be YYYY-MM-DD"),
  format: z.enum(STATEMENT_FORMATS),
});

function requireScope(principal: Principal, scope: string): void {
  if (!principal.scopes.includes(scope)) {
    throw forbidden(`api key lacks ${scope} scope`);
  }
}

function extensionFor(format: StatementFormat): string {
  return format;
}

export function registerStatementRoutes(app: FastifyInstance, deps: StatementRouteDeps): void {
  const { db, env, clock } = deps;

  async function sendStatement(
    reply: FastifyReply,
    tenantId: string,
    accountId: string,
    from: string,
    to: string,
    format: StatementFormat,
  ) {
    const statement = await loadStatement(db, { tenantId, accountId, from, to });

    if (format === "json") {
      return reply.status(200).send(renderStatementJson(statement));
    }

    const file = `statement-${from}-${to}.${extensionFor(format)}`;
    reply.header("content-disposition", `attachment; filename="${file}"`);

    if (format === "csv") {
      return reply.type("text/csv; charset=utf-8").send(renderStatementCsv(statement));
    }
    return reply.type("text/plain; charset=utf-8").send(renderStatementMt940(statement));
  }

  /** Date-range statement; `format=json|csv|mt940`, defaults to today's JSON. */
  app.get<{ Params: { id: string } }>("/v1/accounts/:id/statement", async (request, reply) => {
    const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
    requireScope(principal, "accounts:read");

    const query = statementQuery.parse(request.query ?? {});
    const today = businessDate(clock.now());
    const to = query.to ?? today;
    const from = query.from ?? to;

    return sendStatement(reply, principal.tenantId, request.params.id, from, to, query.format);
  });

  /** Daily statement convenience path: `/v1/accounts/{id}/statements/{date}/{format}`. */
  app.get<{ Params: { id: string; date: string; format: string } }>(
    "/v1/accounts/:id/statements/:date/:format",
    async (request, reply) => {
      const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
      requireScope(principal, "accounts:read");

      const params = pathParams.parse(request.params);
      return sendStatement(
        reply,
        principal.tenantId,
        params.id,
        params.date,
        params.date,
        params.format,
      );
    },
  );
}
