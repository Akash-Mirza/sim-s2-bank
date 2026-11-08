import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SECRET_PREFIX = "whsec_";

/** A fresh signing secret, shown to the tenant exactly once. */
export function generateWebhookSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/**
 * Derive the AES key used to store signing secrets at rest. `WEBHOOK_SECRET_KEY`
 * is preferred; when absent the API key pepper is hashed into a distinct key so a
 * deployment cannot accidentally reuse one secret verbatim for two purposes.
 */
export function deriveWebhookEncryptionKey(input: {
  webhookSecretKey?: string;
  apiKeyPepper: string;
}): Buffer {
  const material =
    input.webhookSecretKey !== undefined && input.webhookSecretKey !== ""
      ? `webhook-key:${input.webhookSecretKey}`
      : `webhook-key:pepper:${input.apiKeyPepper}`;
  return createHash("sha256").update(material).digest();
}

/** `v1.<iv>.<tag>.<ciphertext>`, all base64url, authenticated with GCM. */
export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(key: Buffer, stored: string): string {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("unsupported webhook secret encoding");
  }
  const iv = Buffer.from(parts[1] ?? "", "base64url");
  const tag = Buffer.from(parts[2] ?? "", "base64url");
  const ciphertext = Buffer.from(parts[3] ?? "", "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("malformed webhook secret");
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** HMAC-SHA256 over `${timestamp}.${body}`; hex so the header stays header-safe. */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function signatureHeader(timestamp: number, signature: string): string {
  return `t=${timestamp},v1=${signature}`;
}

export interface VerifyResult {
  valid: boolean;
  reason?: "malformed" | "no_match" | "stale";
}

/**
 * Verify `t=<unix>,v1=<hex>` against the raw body. The timestamp is part of the
 * signed material, so a captured delivery cannot be replayed outside the window.
 */
export function verifyWebhookSignature(input: {
  secret: string;
  header: string | undefined;
  body: string;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): VerifyResult {
  if (input.header === undefined || input.header === "") {
    return { valid: false, reason: "malformed" };
  }

  const fields = new Map<string, string[]>();
  for (const part of input.header.split(",")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    fields.set(name, [...(fields.get(name) ?? []), value]);
  }

  const timestampRaw = fields.get("t")?.[0];
  const signatures = fields.get("v1") ?? [];
  if (timestampRaw === undefined || signatures.length === 0 || !/^\d+$/.test(timestampRaw)) {
    return { valid: false, reason: "malformed" };
  }

  const timestamp = Number(timestampRaw);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const tolerance = input.toleranceSeconds ?? 300;
  if (Math.abs(now - timestamp) > tolerance) {
    return { valid: false, reason: "stale" };
  }

  const expected = Buffer.from(signWebhook(input.secret, timestamp, input.body), "hex");
  for (const candidate of signatures) {
    if (!/^[0-9a-f]{64}$/i.test(candidate)) continue;
    const provided = Buffer.from(candidate, "hex");
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      return { valid: true };
    }
  }
  return { valid: false, reason: "no_match" };
}
