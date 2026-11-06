import type { Pool } from "pg";
import { hashApiKeySecret, parseApiKey, safeEqualHex } from "../adapters/crypto/api-keys.js";
import { findApiKeyByPrefix, touchApiKey } from "../adapters/db/tenants.js";
import { DomainError } from "../domain/errors.js";

export interface Principal {
  tenantId: string;
  scopes: string[];
  keyId: string;
}

function unauthorized(message: string): DomainError {
  return new DomainError("unauthorized", message, 401);
}

/** Resolve the tenant from the bearer key. The body never selects the tenant. */
export async function authenticate(
  db: Pool,
  pepper: string,
  authorization: string | undefined,
): Promise<Principal> {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    throw unauthorized("missing bearer API key");
  }

  const parsed = parseApiKey(authorization.slice("Bearer ".length));
  if (parsed === null) throw unauthorized("malformed API key");

  const record = await findApiKeyByPrefix(db, parsed.prefix);
  if (record === null || record.status !== "active")
    throw unauthorized("unknown or revoked API key");

  const presented = hashApiKeySecret(parsed.secret, pepper);
  if (!safeEqualHex(presented, record.secretHash)) throw unauthorized("unknown or revoked API key");

  void touchApiKey(db, record.id).catch(() => undefined);

  return { tenantId: record.tenantId, scopes: record.scopes, keyId: record.id };
}
