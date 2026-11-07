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
