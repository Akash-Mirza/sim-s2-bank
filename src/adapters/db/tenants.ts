import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { generateApiKey } from "../crypto/api-keys.js";

export interface Tenant {
  id: string;
  code: string;
  legalName: string;
  jurisdiction: string;
  status: string;
}

interface TenantRow {
  id: string;
  code: string;
  legal_name: string;
  jurisdiction: string;
  status: string;
}

function mapTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    code: row.code,
    legalName: row.legal_name,
    jurisdiction: row.jurisdiction,
    status: row.status,
  };
}

export async function createTenant(
  db: Pool,
  input: { code: string; legalName: string; jurisdiction?: string },
): Promise<Tenant> {
  const result = await db.query<TenantRow>(
    `INSERT INTO tenants (code, legal_name, jurisdiction)
     VALUES ($1, $2, $3)
     RETURNING id, code, legal_name, jurisdiction, status`,
    [input.code, input.legalName, input.jurisdiction ?? "AE"],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("tenant insert returned no row");
  return mapTenant(row);
}

export interface IssuedApiKey {
  id: string;
  prefix: string;
  key: string;
  scopes: string[];
}

export async function createApiKey(
  db: Pool,
  input: { tenantId: string; pepper: string; scopes?: string[] },
): Promise<IssuedApiKey> {
  const generated = generateApiKey(input.pepper);
  const scopes = input.scopes ?? [
    "accounts:read",
    "accounts:write",
    "payouts:read",
    "payouts:write",
    "webhooks:read",
    "webhooks:write",
    "events:read",
  ];
  const result = await db.query<{ id: string }>(
    `INSERT INTO api_keys (tenant_id, prefix, secret_hash, scopes)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [input.tenantId, generated.prefix, generated.secretHash, scopes],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("api key insert returned no row");
  return { id: row.id, prefix: generated.prefix, key: generated.key, scopes };
}

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  secretHash: string;
  scopes: string[];
  status: string;
}

export async function findApiKeyByPrefix(db: Pool, prefix: string): Promise<ApiKeyRecord | null> {
  const result = await db.query<{
    id: string;
    tenant_id: string;
    secret_hash: string;
    scopes: string[];
    status: string;
  }>(
    `SELECT id, tenant_id, secret_hash, scopes, status
       FROM api_keys
      WHERE prefix = $1`,
    [prefix],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    secretHash: row.secret_hash,
    scopes: row.scopes,
    status: row.status,
  };
}

export async function touchApiKey(db: Pool, id: string): Promise<void> {
  await db.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [id]);
}

export interface ApiKeySummary {
  id: string;
  tenantCode: string;
  prefix: string;
  scopes: string[];
  status: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Metadata only — the secret hash never leaves the database. */
export async function listApiKeys(db: Pool, tenantCode?: string): Promise<ApiKeySummary[]> {
  const result = await db.query<{
    id: string;
    tenant_code: string;
    prefix: string;
    scopes: string[];
    status: string;
    created_at: Date;
    last_used_at: Date | null;
  }>(
    `SELECT k.id, t.code AS tenant_code, k.prefix, k.scopes, k.status,
            k.created_at, k.last_used_at
       FROM api_keys k
       JOIN tenants t ON t.id = k.tenant_id
      WHERE ($1::text IS NULL OR t.code = $1)
      ORDER BY k.created_at ASC`,
    [tenantCode ?? null],
  );
  return result.rows.map((row) => ({
    id: row.id,
    tenantCode: row.tenant_code,
    prefix: row.prefix,
    scopes: row.scopes,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at === null ? null : row.last_used_at.toISOString(),
  }));
}

/** Revoke by prefix. Revocation is a status flip; the row and its history stay. */
export async function revokeApiKey(db: Pool, prefix: string): Promise<ApiKeySummary | null> {
  const result = await db.query<{ id: string }>(
    "UPDATE api_keys SET status = 'revoked' WHERE prefix = $1 RETURNING id",
    [prefix],
  );
  if (result.rows[0] === undefined) return null;
  const all = await listApiKeys(db);
  return all.find((key) => key.id === result.rows[0]?.id) ?? null;
}

export async function createTenantWithId(
  db: Pool,
  input: { id?: string; code: string; legalName: string },
): Promise<Tenant> {
  const result = await db.query<TenantRow>(
    `INSERT INTO tenants (id, code, legal_name)
     VALUES ($1, $2, $3)
     RETURNING id, code, legal_name, jurisdiction, status`,
    [input.id ?? randomUUID(), input.code, input.legalName],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("tenant insert returned no row");
  return mapTenant(row);
}
