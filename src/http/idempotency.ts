import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { idempotencyConflict, validationError } from "../domain/errors.js";

const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

/** Deterministic JSON so the same body always produces the same hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function requestHash(method: string, route: string, body: unknown): string {
  return createHash("sha256")
    .update(`${method.toUpperCase()} ${route} ${canonicalJson(body ?? null)}`)
    .digest("hex");
}

/** Idempotency-Key is required on every write; it must be printable and bounded. */
export function requireIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (key === undefined || key.trim() === "") {
    throw validationError("Idempotency-Key header is required on writes");
  }
  if (!KEY_PATTERN.test(key)) {
    throw validationError("Idempotency-Key must be 1-255 printable ASCII characters (no spaces)");
  }
  return key;
}

interface StoredIdempotencyRow {
  request_hash: string;
  response_status: number;
  response_body: unknown;
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Run a write exactly once per (tenant, Idempotency-Key).
 *
 * The key row, the business change, and the stored response commit together, so a
 * crash cannot separate them. Concurrent requests with the same key serialize on a
 * transaction advisory lock: one posts, the rest replay its stored response.
 * A retry with a different body under the same key is a 409, never a second posting.
 */
export async function withIdempotency<T>(
  ctx: {
    db: Pool;
    tenantId: string;
    key: string;
    method: string;
    route: string;
    body: unknown;
  },
  produce: (client: PoolClient) => Promise<{ status: number; body: T }>,
): Promise<IdempotentResult<T>> {
  const hash = requestHash(ctx.method, ctx.route, ctx.body);
  const client = await ctx.db.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `${ctx.tenantId}:${ctx.key}`,
    ]);
    await client.query("DELETE FROM idempotency_keys WHERE tenant_id = $1 AND expires_at < now()", [
      ctx.tenantId,
    ]);

    const existing = await client.query<StoredIdempotencyRow>(
      `SELECT request_hash, response_status, response_body
         FROM idempotency_keys
        WHERE tenant_id = $1 AND key = $2`,
      [ctx.tenantId, ctx.key],
    );
    const row = existing.rows[0];

    if (row !== undefined) {
      if (row.request_hash !== hash) {
        throw idempotencyConflict(
          "Idempotency-Key was already used with a different request body or route",
        );
      }
      await client.query("COMMIT");
      return { status: row.response_status, body: row.response_body as T, replayed: true };
    }

    const produced = await produce(client);

    await client.query(
      `INSERT INTO idempotency_keys (
         tenant_id, key, request_hash, method, route, response_status, response_body
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        ctx.tenantId,
        ctx.key,
        hash,
        ctx.method,
        ctx.route,
        produced.status,
        JSON.stringify(produced.body),
      ],
    );
    await client.query("COMMIT");

    return { status: produced.status, body: produced.body, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
