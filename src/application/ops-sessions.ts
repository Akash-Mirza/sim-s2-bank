import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { safeEqualHex } from "../adapters/crypto/api-keys.js";
import { verifyPassword } from "../adapters/crypto/passwords.js";
import {
  type OpsRole,
  type OpsUserRecord,
  findOpsSessionByPrefix,
  findOpsUserByEmail,
  insertOpsSession,
  markOpsLogin,
  revokeOpsSession,
  touchOpsSession,
} from "../adapters/db/ops.js";
import { DomainError } from "../domain/errors.js";

const TOKEN_PATTERN = /^ops_([0-9a-f]{8})_([A-Za-z0-9_-]{20,})$/;
const SESSION_TTL_DEFAULT_HOURS = 12;

export interface OpsPrincipal {
  sessionId: string | null;
  userId: string | null;
  email: string;
  displayName: string;
  role: OpsRole;
  via: "session" | "dev-token";
}

export interface OpsLoginResult {
  token: string;
  expiresAt: string;
  user: OpsUserRecord;
}

export function parseOpsToken(token: string): { prefix: string; secret: string } | null {
  const match = TOKEN_PATTERN.exec(token.trim());
  if (match === null) return null;
  return { prefix: match[1] ?? "", secret: match[2] ?? "" };
}

/** Session tokens are hashed with the API pepper so a DB dump cannot be replayed. */
export function hashSessionSecret(secret: string, pepper: string): string {
  return createHash("sha256").update(`${pepper}:ops-session:${secret}`).digest("hex");
}

/**
 * Exchange email + password for one short-lived session token.
 *
 * The response is deliberately identical for an unknown email, a disabled user and
 * a wrong password: the login route must not become a user directory.
 */
export async function loginOpsUser(
  db: Pool,
  input: { email: string; password: string; pepper: string; ttlHours?: number },
): Promise<OpsLoginResult> {
  const rejected = new DomainError("unauthorized", "invalid email or password", 401);
  const found = await findOpsUserByEmail(db, input.email);
  if (found === null) throw rejected;
  if (found.user.status !== "active") throw rejected;
  if (!verifyPassword(input.password, found.passwordHash)) throw rejected;

  const prefix = randomBytes(4).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const ttlHours = input.ttlHours ?? SESSION_TTL_DEFAULT_HOURS;
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await insertOpsSession(client, {
      userId: found.user.id,
      tokenPrefix: prefix,
      tokenHash: hashSessionSecret(secret, input.pepper),
      expiresAt,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  await markOpsLogin(db, found.user.id);

  return {
    token: `ops_${prefix}_${secret}`,
    expiresAt: expiresAt.toISOString(),
    user: found.user,
  };
}

/** Resolve a Bearer ops token to its principal, or null when it is not usable. */
export async function resolveOpsSession(
  db: Pool,
  pepper: string,
  authorization: string | undefined,
): Promise<OpsPrincipal | null> {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) return null;

  const parsed = parseOpsToken(authorization.slice("Bearer ".length));
  if (parsed === null) return null;

  const session = await findOpsSessionByPrefix(db, parsed.prefix);
  if (session === null) return null;
  if (session.revokedAt !== null) return null;
  if (session.userStatus !== "active") return null;
  if (Date.parse(session.expiresAt) <= Date.now()) return null;
  if (!safeEqualHex(hashSessionSecret(parsed.secret, pepper), session.tokenHash)) return null;

  void touchOpsSession(db, session.sessionId).catch(() => undefined);

  return {
    sessionId: session.sessionId,
    userId: session.userId,
    email: session.email,
    displayName: session.displayName,
    role: session.role,
    via: "session",
  };
}

export async function logoutOpsSession(db: Pool, sessionId: string): Promise<void> {
  await revokeOpsSession(db, sessionId);
}
