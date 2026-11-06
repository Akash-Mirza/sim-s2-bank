import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { getAccount, listAccounts, listTransactions } from "../../adapters/db/accounts.js";
import { createAccountTx } from "../../application/create-account.js";
import { postMovementTx } from "../../application/post-movement.js";
import type { Clock } from "../../config/clock.js";
import type { Env } from "../../config/env.js";
import { MODE } from "../../domain/constants.js";
import { notFound, validationError } from "../../domain/errors.js";
import { formatAmountMinor, parseAmountMinor } from "../../domain/money.js";
import { authenticate } from "../auth.js";
import { requireIdempotencyKey, withIdempotency } from "../idempotency.js";

export interface AccountRouteDeps {
  db: Pool;
  env: Env;
  clock: Clock;
}

const createAccountBody = z.object({
  product_code: z.string().min(1).max(64).optional(),
});

const creditBody = z.object({
  amount: z.string().min(1),
  currency: z.literal("AED").default("AED"),
  reference: z.string().max(140).optional(),
  end_to_end_id: z.string().max(35).optional(),
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

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});

function serializeBalance(balance: {
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

function serializeAccount(account: {
  id: string;
  accountNumber: string;
  iban: string;
  bic: string;
  currency: string;
  productCode: string;
  status: string;
  openedAt: string;
}) {
  return {
    id: account.id,
    account_number: account.accountNumber,
    iban: account.iban,
    bic: account.bic,
    currency: account.currency,
    product_code: account.productCode,
    status: account.status,
    opened_at: account.openedAt,
  };
}

export function registerAccountRoutes(app: FastifyInstance, deps: AccountRouteDeps): void {
  const { db, env, clock } = deps;

  app.post("/v1/accounts", async (request, reply) => {
    const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
    const body = createAccountBody.parse(request.body ?? {});
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
        const account = await createAccountTx(client, {
          tenantId: principal.tenantId,
          productCode: body.product_code,
          actor: `api_key:${principal.keyId}`,
          requestId: request.id,
        });

        return {
          status: 201,
          body: {
            mode: MODE,
            account: serializeAccount(account),
            balance: serializeBalance({
              availableMinor: 0n,
              pendingMinor: 0n,
              heldMinor: 0n,
              ledgerMinor: 0n,
            }),
          },
        };
      },
    );

    if (result.replayed) reply.header("idempotent-replayed", "true");
    return reply.status(result.status).send(result.body);
  });

  app.get("/v1/accounts", async (request) => {
    const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
    const accounts = await listAccounts(db, principal.tenantId);
    return {
      mode: MODE,
      data: accounts.map(({ account, balance }) => ({
        ...serializeAccount(account),
        balance: serializeBalance(balance),
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/v1/accounts/:id", async (request) => {
    const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
    const found = await getAccount(db, principal.tenantId, request.params.id);
    if (found === null) throw notFound("account not found");
    return {
      mode: MODE,
      account: serializeAccount(found.account),
      balance: serializeBalance(found.balance),
    };
  });

  app.get<{ Params: { id: string } }>("/v1/accounts/:id/balance", async (request) => {
    const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
    const found = await getAccount(db, principal.tenantId, request.params.id);
    if (found === null) throw notFound("account not found");
    return {
      mode: MODE,
      balance: serializeBalance(found.balance),
      version: `${found.balance.version}`,
    };
  });

  app.get<{ Params: { id: string } }>("/v1/accounts/:id/transactions", async (request) => {
    const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
    const query = listQuery.parse(request.query ?? {});
    const page = await listTransactions(db, principal.tenantId, request.params.id, {
      limit: query.limit,
      cursor: query.cursor,
    });
    return {
      mode: MODE,
      data: page.data.map((transaction) => ({
        id: transaction.id,
        type: transaction.type,
        status: transaction.status,
        amount: formatAmountMinor(transaction.amountMinor),
        currency: transaction.currency,
        reference: transaction.reference,
        value_date: transaction.valueDate,
        booking_date: transaction.bookingDate,
        posted_at: transaction.postedAt,
      })),
      next_cursor: page.nextCursor,
    };
  });

  app.post<{ Params: { id: string } }>(
    "/v1/accounts/:id/credits:simulate",
    async (request, reply) => {
      const principal = await authenticate(db, env.apiKeyPepper, request.headers.authorization);
      if (!principal.scopes.includes("accounts:write")) {
        throw validationError("api key lacks accounts:write scope");
      }
      const body = creditBody.parse(request.body ?? {});
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
          const movement = await postMovementTx(client, clock, {
            tenantId: principal.tenantId,
            accountId: request.params.id,
            direction: "credit",
            type: "credit_transfer",
            amountMinor,
            reference: body.reference,
            endToEndId: body.end_to_end_id,
            remitter: body.remitter,
            valueDate: body.value_date,
            actor: `api_key:${principal.keyId}`,
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
}
