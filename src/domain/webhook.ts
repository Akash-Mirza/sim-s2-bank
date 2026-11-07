import { validationError } from "./errors.js";

/** Every event the simulator can emit. A subscription names these or a wildcard. */
export const EVENT_TYPES = [
  "credit.posted",
  "reversal.posted",
  "hold.created",
  "hold.released",
  "hold.captured",
  "payout.created",
  "payout.validated",
  "payout.submitted",
  "payout.accepted",
  "payout.settled",
  "payout.cancelled",
  "payout.failed",
  "payout.returned",
  "eod.closed",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const MAX_EVENT_PAYLOAD_BYTES = 65_536;
export const MAX_EVENTS_PER_SUBSCRIPTION = 32;
export const DEFAULT_MAX_ATTEMPTS = 5;
export const MAX_RETRY_DELAY_SECONDS = 300;

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

export function validateEventType(value: string): EventType {
  if (!isEventType(value)) {
    throw validationError(`unknown event type ${value}`, { allowed: EVENT_TYPES });
  }
  return value;
}

/**
 * Subscription filter matching. `*` selects everything; `payout.*` selects the
 * whole family; otherwise the type must match exactly.
 */
export function matchesEvent(filters: readonly string[], type: string): boolean {
  return filters.some((filter) => {
    if (filter === "*") return true;
    if (filter.endsWith(".*")) return type.startsWith(filter.slice(0, -1));
    return filter === type;
  });
}

/** Validate the subscription filter list: known types or wildcards, no duplicates. */
export function validateEventFilters(filters: readonly string[]): string[] {
  if (filters.length === 0) {
    throw validationError("events must name at least one event type");
  }
  if (filters.length > MAX_EVENTS_PER_SUBSCRIPTION) {
    throw validationError(`at most ${MAX_EVENTS_PER_SUBSCRIPTION} event filters are allowed`);
  }

  const unique = [...new Set(filters.map((filter) => filter.trim()))];
  for (const filter of unique) {
    if (filter === "*") continue;
    if (filter.endsWith(".*")) {
      const family = filter.slice(0, -1);
      if (!EVENT_TYPES.some((type) => type.startsWith(family))) {
        throw validationError(`unknown event family ${filter}`, { allowed: EVENT_TYPES });
      }
      continue;
    }
    validateEventType(filter);
  }
  return unique;
}

/**
 * Delivery URLs must be absolute http(s), carry no credentials, and stay short.
 * Plain http is accepted only for loopback receivers or outside production, so a
 * local demo works while a deployed simulator cannot ship events in clear text.
 */
export function validateWebhookUrl(url: string, options: { production: boolean }): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw validationError("url must be an absolute http(s) URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw validationError("url must use http or https");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw validationError("url must not embed credentials");
  }
  if (url.length > 2_048) {
    throw validationError("url must be at most 2048 characters");
  }

  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "[::1]";

  if (parsed.protocol === "http:" && options.production && !loopback) {
    throw validationError("url must use https outside local development");
  }

  return parsed.toString();
}

/**
 * Exponential backoff in whole seconds after a failed attempt. Attempt 1 waits 2s,
 * then 4s, 8s, 16s and so on, capped so a dead receiver cannot stall forever.
 */
export function retryDelaySeconds(attempts: number): number {
  const safe = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0;
  return Math.min(2 ** safe, MAX_RETRY_DELAY_SECONDS);
}

/** Envelope posted to the receiver. Stable across deliveries of the same event. */
export interface WebhookEnvelope {
  id: string;
  type: string;
  created_at: string;
  data: unknown;
}

export function buildEnvelope(input: {
  id: string;
  type: string;
  createdAt: string;
  payload: unknown;
}): WebhookEnvelope {
  return {
    id: input.id,
    type: input.type,
    created_at: input.createdAt,
    data: input.payload,
  };
}

/** Serialize once so the signature and the body bytes are exactly the same. */
export function serializeEnvelope(envelope: WebhookEnvelope): string {
  return JSON.stringify(envelope);
}
