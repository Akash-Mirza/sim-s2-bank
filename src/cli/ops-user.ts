import { hashPassword } from "../adapters/crypto/passwords.js";
import { OPS_ROLES, type OpsRole, insertOpsUser, listOpsUsers } from "../adapters/db/ops.js";
import { createPool } from "../adapters/db/pool.js";
import { loadDotenv } from "../config/dotenv.js";
import { loadEnv } from "../config/env.js";

/**
 * Create or list ops users.
 *
 *   node dist/cli/ops-user.js create --email ops@example.com --name "Ops" \
 *        --role operator --password 'a-long-password'
 *   node dist/cli/ops-user.js list
 *
 * The password may also come from OPS_USER_PASSWORD. It is never printed and never
 * logged; only the scrypt hash is stored.
 */
function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return args[index + 1];
}

async function create(args: string[]): Promise<void> {
  const email = flag(args, "email");
  const role = (flag(args, "role") ?? "operator") as OpsRole;
  const name = flag(args, "name") ?? email ?? "Ops user";
  const password = flag(args, "password") ?? process.env.OPS_USER_PASSWORD;

  if (email === undefined || email.trim() === "") throw new Error("--email is required");
  if (!OPS_ROLES.includes(role)) throw new Error(`--role must be one of ${OPS_ROLES.join(", ")}`);
  if (password === undefined || password === "") {
    throw new Error("--password or OPS_USER_PASSWORD is required");
  }

  loadDotenv();
  const env = loadEnv();
  const pool = createPool(env.databaseUrl);

  try {
    const existing = await pool.query<{ id: string }>("SELECT id FROM ops_users WHERE email = $1", [
      email.toLowerCase(),
    ]);
    if (existing.rows[0] !== undefined) {
      throw new Error(`ops user ${email} already exists`);
    }

    const user = await insertOpsUser(pool, {
      email,
      displayName: name,
      passwordHash: hashPassword(password),
      role,
    });

    console.log(
      JSON.stringify(
        { level: "info", msg: "ops user created", user: { ...user, password_hash: "redacted" } },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

async function list(): Promise<void> {
  loadDotenv();
  const env = loadEnv();
  const pool = createPool(env.databaseUrl);
  try {
    const users = await listOpsUsers(pool);
    console.log(
      JSON.stringify({ level: "info", msg: "ops users", count: users.length, users }, null, 2),
    );
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "create") {
    await create(args);
    return;
  }
  if (command === "list") {
    await list();
    return;
  }
  throw new Error("usage: ops-user.js <create|list> [--email ...] [--name ...] [--role ...]");
}

main().catch((error) => {
  console.error(JSON.stringify({ level: "error", msg: "ops-user failed", error: `${error}` }));
  process.exit(1);
});
