import { createPool } from "../adapters/db/pool.js";
import {
  type ApiKeySummary,
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "../adapters/db/tenants.js";
import { loadDotenv } from "../config/dotenv.js";
import { loadEnv } from "../config/env.js";

/**
 * Issue, list and revoke tenant API keys.
 *
 *   node dist/cli/api-key.js create --tenant demo-bank-client
 *   node dist/cli/api-key.js create --tenant demo-bank-client --scopes accounts:read,events:read
 *   node dist/cli/api-key.js list [--tenant demo-bank-client]
 *   node dist/cli/api-key.js revoke --prefix s2k_ab12cd34
 *
 * The plaintext key is printed exactly once, at creation. Only its prefix and
 * hash are stored; listing never returns either the secret or its hash.
 */
function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return args[index + 1];
}

async function withPool<T>(
  work: (pool: ReturnType<typeof createPool>, pepper: string) => Promise<T>,
) {
  loadDotenv();
  const env = loadEnv();
  const pool = createPool(env.databaseUrl);
  try {
    return await work(pool, env.apiKeyPepper);
  } finally {
    await pool.end();
  }
}

async function resolveTenantId(
  pool: ReturnType<typeof createPool>,
  code: string | undefined,
): Promise<string> {
  if (code === undefined || code.trim() === "") throw new Error("--tenant is required");
  const result = await pool.query<{ id: string }>("SELECT id FROM tenants WHERE code = $1", [code]);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`tenant ${code} does not exist`);
  return row.id;
}

async function create(args: string[]): Promise<void> {
  const tenantCode = flag(args, "tenant");
  const scopes = flag(args, "scopes")
    ?.split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope !== "");

  const issued = await withPool(async (pool, pepper) => {
    const tenantId = await resolveTenantId(pool, tenantCode);
    return createApiKey(pool, {
      tenantId,
      pepper,
      ...(scopes === undefined || scopes.length === 0 ? {} : { scopes }),
    });
  });

  // Printed once. It is not recoverable afterwards — only its prefix is stored.
  console.log(
    JSON.stringify(
      {
        level: "info",
        msg: "api key issued",
        tenant: tenantCode,
        id: issued.id,
        prefix: issued.prefix,
        scopes: issued.scopes,
        key: issued.key,
        note: "store it now; only the prefix and hash are persisted",
      },
      null,
      2,
    ),
  );
}

async function list(args: string[]): Promise<void> {
  const tenantCode = flag(args, "tenant");
  const keys = await withPool((pool) => listApiKeys(pool, tenantCode));
  console.log(
    JSON.stringify({ level: "info", msg: "api keys", count: keys.length, keys }, null, 2),
  );
}

async function revoke(args: string[]): Promise<void> {
  const prefix = flag(args, "prefix");
  if (prefix === undefined || prefix.trim() === "") throw new Error("--prefix is required");
  const key = await withPool((pool) => revokeApiKey(pool, prefix));
  if (key === null) throw new Error(`no api key with prefix ${prefix}`);
  const summary: ApiKeySummary = key;
  console.log(JSON.stringify({ level: "info", msg: "api key revoked", key: summary }, null, 2));
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "create") {
    await create(args);
    return;
  }
  if (command === "list") {
    await list(args);
    return;
  }
  if (command === "revoke") {
    await revoke(args);
    return;
  }
  throw new Error(
    "usage: api-key.js <create|list|revoke> [--tenant ...] [--scopes ...] [--prefix ...]",
  );
}

main().catch((error) => {
  console.error(JSON.stringify({ level: "error", msg: "api-key failed", error: `${error}` }));
  process.exit(1);
});
