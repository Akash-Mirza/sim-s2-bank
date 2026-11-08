import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  deriveWebhookEncryptionKey,
  encryptSecret,
  generateWebhookSecret,
  signWebhook,
  signatureHeader,
  verifyWebhookSignature,
} from "../../src/adapters/crypto/webhooks.js";
import {
  EVENT_TYPES,
  MAX_RETRY_DELAY_SECONDS,
  buildEnvelope,
  matchesEvent,
  retryDelaySeconds,
  serializeEnvelope,
  validateEventFilters,
  validateWebhookUrl,
} from "../../src/domain/webhook.js";

describe("webhook event filters", () => {
  it("matches exact types, families and the global wildcard", () => {
    expect(matchesEvent(["credit.posted"], "credit.posted")).toBe(true);
    expect(matchesEvent(["credit.posted"], "reversal.posted")).toBe(false);
    expect(matchesEvent(["payout.*"], "payout.settled")).toBe(true);
    expect(matchesEvent(["payout.*"], "payout.returned")).toBe(true);
    expect(matchesEvent(["payout.*"], "credit.posted")).toBe(false);
    expect(matchesEvent(["*"], "eod.closed")).toBe(true);
    expect(matchesEvent([], "credit.posted")).toBe(false);
  });

  it("validates, trims and de-duplicates filters", () => {
    expect(validateEventFilters([" credit.posted ", "credit.posted", "payout.*"])).toEqual([
      "credit.posted",
      "payout.*",
    ]);
    expect(() => validateEventFilters([])).toThrow(/at least one/);
    expect(() => validateEventFilters(["credit.bounced"])).toThrow(/unknown event type/);
    expect(() => validateEventFilters(["transfer.*"])).toThrow(/unknown event family/);
    expect(() => validateEventFilters(Array.from({ length: 33 }, (_, i) => `x${i}`))).toThrow(
      /at most 32/,
    );
  });

  it("covers every declared event type", () => {
    for (const type of EVENT_TYPES) {
      expect(matchesEvent([type], type)).toBe(true);
      expect(matchesEvent([`${type.split(".")[0]}.*`], type)).toBe(true);
    }
  });
});

describe("webhook URL policy", () => {
  it("accepts https anywhere and loopback http everywhere", () => {
    expect(() =>
      validateWebhookUrl("https://example.com/hook", { production: true }),
    ).not.toThrow();
    expect(() =>
      validateWebhookUrl("http://127.0.0.1:9000/hook", { production: true }),
    ).not.toThrow();
    expect(() =>
      validateWebhookUrl("http://localhost:9000/hook", { production: true }),
    ).not.toThrow();
  });

  it("refuses plain http to a remote host in production only", () => {
    expect(() => validateWebhookUrl("http://example.com/hook", { production: true })).toThrow(
      /https outside local development/,
    );
    expect(() =>
      validateWebhookUrl("http://example.com/hook", { production: false }),
    ).not.toThrow();
  });

  it("refuses credentials, non-http schemes and relative URLs", () => {
    expect(() =>
      validateWebhookUrl("https://user:pass@example.com/hook", { production: true }),
    ).toThrow(/credentials/);
    expect(() => validateWebhookUrl("ftp://example.com/hook", { production: true })).toThrow(
      /http or https/,
    );
    expect(() => validateWebhookUrl("/hook", { production: true })).toThrow(/absolute/);
  });
});

describe("webhook retry backoff", () => {
  it("doubles from two seconds and caps at five minutes", () => {
    expect(retryDelaySeconds(0)).toBe(1);
    expect(retryDelaySeconds(1)).toBe(2);
    expect(retryDelaySeconds(2)).toBe(4);
    expect(retryDelaySeconds(3)).toBe(8);
    expect(retryDelaySeconds(4)).toBe(16);
    expect(retryDelaySeconds(5)).toBe(32);
    expect(retryDelaySeconds(20)).toBe(MAX_RETRY_DELAY_SECONDS);
    expect(retryDelaySeconds(-3)).toBe(1);
  });
});

describe("webhook secret encryption", () => {
  const key = deriveWebhookEncryptionKey({ apiKeyPepper: "pepper-0123456789abcdef" });

  it("generates a prefixed secret and round-trips it", () => {
    const secret = generateWebhookSecret();
    expect(secret.startsWith("whsec_")).toBe(true);
    expect(secret.length).toBeGreaterThan(40);

    const stored = encryptSecret(key, secret);
    expect(stored.startsWith("v1.")).toBe(true);
    expect(stored).not.toContain(secret);
    expect(decryptSecret(key, stored)).toBe(secret);
  });

  it("uses a different ciphertext for the same plaintext", () => {
    const secret = generateWebhookSecret();
    expect(encryptSecret(key, secret)).not.toBe(encryptSecret(key, secret));
  });

  it("fails to decrypt with the wrong key or a tampered payload", () => {
    const secret = generateWebhookSecret();
    const other = deriveWebhookEncryptionKey({
      webhookSecretKey: "dedicated-webhook-key-0123456789",
      apiKeyPepper: "pepper-0123456789abcdef",
    });
    const stored = encryptSecret(key, secret);

    expect(() => decryptSecret(other, stored)).toThrow();
    const parts = stored.split(".");
    const tampered = [parts[0], parts[1], parts[2], `${parts[3]?.slice(0, -2)}AA`].join(".");
    expect(() => decryptSecret(key, tampered)).toThrow();
  });

  it("prefers an explicit webhook key over the API pepper", () => {
    const withExplicit = deriveWebhookEncryptionKey({
      webhookSecretKey: "dedicated-webhook-key-0123456789",
      apiKeyPepper: "pepper-0123456789abcdef",
    });
    const fromPepper = deriveWebhookEncryptionKey({ apiKeyPepper: "pepper-0123456789abcdef" });
    expect(withExplicit.equals(fromPepper)).toBe(false);
    expect(withExplicit).toHaveLength(32);
  });
});

describe("webhook signatures", () => {
  const secret = "whsec_test_secret_0123456789";
  const now = 1_800_000_000;

  it("signs `${t}.${body}` and verifies it", () => {
    const body = JSON.stringify({ hello: "world" });
    const signature = signWebhook(secret, now, body);
    const header = signatureHeader(now, signature);

    expect(verifyWebhookSignature({ secret, header, body, nowSeconds: now })).toEqual({
      valid: true,
    });
  });

  it("rejects a changed body, a changed secret and a stale timestamp", () => {
    const body = JSON.stringify({ amount: "10.00" });
    const header = signatureHeader(now, signWebhook(secret, now, body));

    expect(
      verifyWebhookSignature({
        secret,
        header,
        body: JSON.stringify({ amount: "99.00" }),
        nowSeconds: now,
      }).reason,
    ).toBe("no_match");

    expect(
      verifyWebhookSignature({
        secret: "whsec_other",
        header,
        body,
        nowSeconds: now,
      }).reason,
    ).toBe("no_match");

    expect(
      verifyWebhookSignature({
        secret,
        header,
        body,
        nowSeconds: now + 301,
        toleranceSeconds: 300,
      }).reason,
    ).toBe("stale");
  });

  it("rejects malformed headers but accepts multiple v1 candidates", () => {
    const body = "{}";
    const good = signWebhook(secret, now, body);

    expect(verifyWebhookSignature({ secret, header: "nope", body, nowSeconds: now }).reason).toBe(
      "malformed",
    );
    expect(
      verifyWebhookSignature({
        secret,
        header: `t=${now},v1=${"0".repeat(64)},v1=${good}`,
        body,
        nowSeconds: now,
      }),
    ).toEqual({ valid: true });
  });
});

describe("webhook envelope", () => {
  it("serializes one stable body for signing and sending", () => {
    const envelope = buildEnvelope({
      id: "11111111-1111-4111-8111-111111111111",
      type: "credit.posted",
      createdAt: "2026-11-07T10:00:00.000Z",
      payload: { amount: "10.00" },
    });
    expect(envelope).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      type: "credit.posted",
      created_at: "2026-11-07T10:00:00.000Z",
      data: { amount: "10.00" },
    });
    expect(serializeEnvelope(envelope)).toBe(
      '{"id":"11111111-1111-4111-8111-111111111111","type":"credit.posted","created_at":"2026-11-07T10:00:00.000Z","data":{"amount":"10.00"}}',
    );
  });
});
