import { createHash, randomBytes } from "node:crypto";
import { timingSafeEqual } from "node:crypto";

export interface GeneratedApiKey {
  key: string;
  prefix: string;
  secretHash: string;
}

export function hashApiKeySecret(secret: string, pepper: string): string {
  return createHash("sha256").update(`${pepper}:${secret}`).digest("hex");
}

/** Key shape: sk_sim_<8 hex prefix>_<32-byte base64url secret>. */
export function generateApiKey(pepper: string): GeneratedApiKey {
  const prefix = randomBytes(4).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  return {
    key: `sk_sim_${prefix}_${secret}`,
    prefix,
    secretHash: hashApiKeySecret(secret, pepper),
  };
}

export function parseApiKey(key: string): { prefix: string; secret: string } | null {
  const match = /^sk_sim_([0-9a-f]{8})_([A-Za-z0-9_-]{20,})$/.exec(key.trim());
  if (match === null) return null;
  return { prefix: match[1] ?? "", secret: match[2] ?? "" };
}

export function safeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
