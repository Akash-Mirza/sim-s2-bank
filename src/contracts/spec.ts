import {
  type JsonSchema,
  amountSchema,
  arrayOf,
  nullableString,
  objectSchema,
  stringSchema,
} from "./schema.js";

export const API_VERSION = "1.0.0";

/**
 * Writes that are deliberately exempt from `Idempotency-Key`: worker ticks and
 * auth. A replay of a dispatch must actually run; a second login must mint a second
 * session. Every other POST/DELETE requires a key, and the contract test enforces
 * that this list is the only exception.
 */
export const IDEMPOTENCY_EXEMPT: ReadonlySet<string> = new Set([
  "POST /v1/outbox/dispatch",
  "POST /ops/v1/outbox/dispatch",
  "POST /ops/v1/clock/freeze",
  "POST /ops/v1/clock/step",
  "POST /ops/v1/clock/resume",
  "POST /ops/v1/auth/login",
  "POST /ops/v1/auth/logout",
]);

export type AuthMode = "none" | "api-key" | "ops-session";

export interface ApiOperation {
  method: "GET" | "POST" | "DELETE";
  /** Fastify path, `:param` form. */
  path: string;
  operationId: string;
  summary: string;
  tag: string;
  auth: AuthMode;
  /** Tenant API-key scope, when auth is `api-key`. */
  scope?: string;
  request?: JsonSchema;
  success: { status: number; schema?: string; contentType?: string };
  /** Extra error statuses beyond 400/401/500. */
  errors?: readonly number[];
}

const balance = objectSchema(
  {
    available: amountSchema("available = ledger - held - pending"),
    pending: amountSchema(),
    held: amountSchema(),
    ledger: amountSchema("book balance"),
  },
  ["available", "pending", "held", "ledger"],
);

const account = objectSchema(
  {
    id: { type: "string", format: "uuid" },
    account_number: stringSchema("16-digit account number"),
    iban: stringSchema("23-character UAE IBAN"),
    bic: stringSchema(),
    currency: { type: "string", enum: ["AED"] },
    product_code: stringSchema(),
    status: { type: "string", enum: ["open", "restricted", "closed"] },
    opened_at: { type: "string", format: "date-time" },
  },
  ["id", "account_number", "iban", "bic", "currency", "product_code", "status", "opened_at"],
);

const beneficiary = objectSchema(
  {
    name: stringSchema(),
    iban: stringSchema(),
    bic: nullableString(),
  },
  ["name", "iban", "bic"],
);

const payout = objectSchema(
  {
    id: { type: "string", format: "uuid" },
    account_id: { type: "string", format: "uuid" },
    status: {
      type: "string",
      enum: [
        "created",
        "validated",
        "submitted",
        "accepted",
        "settled",
        "returned",
        "failed",
        "cancelled",
      ],
    },
    amount: amountSchema(),
    currency: { type: "string", enum: ["AED"] },
    reference: nullableString(),
    end_to_end_id: nullableString(),
    beneficiary,
    hold_id: nullableString(),
    transaction_id: nullableString(),
    settled_amount: nullableString("what the beneficiary actually received"),
    scheduled_for: { type: "string", format: "date" },
    cutoff_at: { type: "string", format: "date-time" },
    submitted_at: nullableString(),
    settled_at: nullableString(),
    failure_code: nullableString(),
    failure_reason: nullableString(),
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  [
    "id",
    "account_id",
    "status",
    "amount",
    "currency",
    "reference",
    "end_to_end_id",
    "beneficiary",
    "hold_id",
    "transaction_id",
    "settled_amount",
    "scheduled_for",
    "cutoff_at",
    "submitted_at",
    "settled_at",
    "failure_code",
    "failure_reason",
    "created_at",
    "updated_at",
  ],
);

const hold = objectSchema(
  {
    id: { type: "string", format: "uuid" },
    account_id: { type: "string", format: "uuid" },
    status: { type: "string", enum: ["active", "released", "expired", "captured"] },
    amount: amountSchema(),
    currency: { type: "string", enum: ["AED"] },
    reason: stringSchema(),
    reference: nullableString(),
    expires_at: nullableString(),
    released_at: nullableString(),
    captured_transaction_id: nullableString(),
    created_at: { type: "string", format: "date-time" },
  },
  [
    "id",
    "account_id",
    "status",
    "amount",
    "currency",
    "reason",
    "reference",
    "expires_at",
    "released_at",
    "captured_transaction_id",
    "created_at",
  ],
);

const scenario = objectSchema(
  {
    id: { type: "string", format: "uuid" },
    tenant_id: { type: "string", format: "uuid" },
    account_id: { type: "string", format: "uuid" },
    payout_id: { type: "string", format: "uuid" },
    kind: { type: "string", enum: ["underpaid", "sanctions_hold", "bank_timeout", "returned"] },
    shortfall_minor: nullableString(),
    shortfall: nullableString(),
    status: { type: "string", enum: ["armed", "consumed", "disarmed"] },
    armed_at: { type: "string", format: "date-time" },
    consumed_at: nullableString(),
    created_at: { type: "string", format: "date-time" },
  },
  [
    "id",
    "tenant_id",
    "account_id",
    "payout_id",
    "kind",
    "shortfall_minor",
    "shortfall",
    "status",
    "armed_at",
    "consumed_at",
    "created_at",
  ],
);

const opsUser = objectSchema(
  {
    id: { type: "string", format: "uuid" },
    email: stringSchema(),
    display_name: stringSchema(),
    role: { type: "string", enum: ["viewer", "operator", "admin"] },
    status: { type: "string", enum: ["active", "disabled"] },
    created_at: { type: "string", format: "date-time" },
    last_login_at: nullableString(),
  },
  ["id", "email", "display_name", "role", "status", "created_at", "last_login_at"],
);

const opsPrincipal = objectSchema(
  {
    session_id: nullableString(),
    user_id: nullableString(),
    email: stringSchema(),
    display_name: stringSchema(),
    role: { type: "string", enum: ["viewer", "operator", "admin"] },
    via: { type: "string", enum: ["session", "dev-token"] },
  },
  ["session_id", "user_id", "email", "display_name", "role", "via"],
);

const delivery = objectSchema(
  {
    id: { type: "string", format: "uuid" },
    subscription_id: { type: "string", format: "uuid" },
    event_id: { type: "string", format: "uuid" },
    status: { type: "string", enum: ["pending", "delivering", "delivered", "failed", "dead"] },
    attempts: { type: "integer" },
    max_attempts: { type: "integer" },
    next_retry_at: { type: "string", format: "date-time" },
    last_status_code: { type: "integer", nullable: true },
    last_error: nullableString(),
    signature: nullableString(),
    delivered_at: nullableString(),
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  [
    "id",
    "subscription_id",
    "event_id",
    "status",
    "attempts",
    "max_attempts",
    "next_retry_at",
    "last_status_code",
    "last_error",
    "signature",
    "delivered_at",
    "created_at",
    "updated_at",
  ],
);

const subscription = objectSchema(
  {
    id: { type: "string", format: "uuid" },
    url: stringSchema(),
    events: arrayOf(stringSchema(), "exact type, family or *"),
    description: nullableString(),
    status: { type: "string", enum: ["active", "disabled"] },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  ["id", "url", "events", "description", "status", "created_at", "updated_at"],
);

const error = objectSchema(
  {
    error: objectSchema(
      {
        code: stringSchema(),
        message: stringSchema(),
        request_id: stringSchema(),
        details: { type: "object", additionalProperties: true, nullable: true },
      },
      ["code", "message", "request_id", "details"],
    ),
  },
  ["error"],
);

const transaction = objectSchema(
  {
    id: { type: "string", format: "uuid" },
    type: stringSchema(),
    status: stringSchema(),
    amount: amountSchema(),
    currency: { type: "string", enum: ["AED"] },
    reference: nullableString(),
    value_date: { type: "string", format: "date" },
    booking_date: { type: "string", format: "date" },
    posted_at: { type: "string", format: "date-time" },
  },
  [
    "id",
    "type",
    "status",
    "amount",
    "currency",
    "reference",
    "value_date",
    "booking_date",
    "posted_at",
  ],
);

const eodEntry = objectSchema(
  {
    id: { type: "string", format: "uuid" },
    account_id: { type: "string", format: "uuid" },
    business_date: { type: "string", format: "date" },
    status: stringSchema(),
    opening_balance: amountSchema(),
    closing_balance: amountSchema(),
    credits: amountSchema(),
    debits: amountSchema(),
    line_count: { type: "integer" },
    checksum: stringSchema("SHA-256 of the closed statement"),
    closed_at: { type: "string", format: "date-time" },
    closed_by: stringSchema(),
  },
  [
    "id",
    "account_id",
    "business_date",
    "status",
    "opening_balance",
    "closing_balance",
    "credits",
    "debits",
    "line_count",
    "checksum",
    "closed_at",
    "closed_by",
  ],
);

const statement = objectSchema(
  {
    account_id: { type: "string", format: "uuid" },
    iban: stringSchema(),
    from: { type: "string", format: "date" },
    to: { type: "string", format: "date" },
    opening_balance: amountSchema(),
    closing_balance: amountSchema(),
    totals: objectSchema(
      {
        credits: amountSchema(),
        debits: amountSchema(),
        count: { type: "integer" },
      },
      ["credits", "debits", "count"],
    ),
    lines: arrayOf({ type: "object", additionalProperties: true }, "one per posted movement"),
  },
  ["account_id", "iban", "from", "to", "opening_balance", "closing_balance", "totals", "lines"],
);

const auditEntry = objectSchema(
  {
    id: { type: "integer" },
    tenant_id: nullableString(),
    actor: stringSchema("api_key:<id>, ops:<email> or seed"),
    action: stringSchema(),
    entity_type: stringSchema(),
    entity_id: nullableString(),
    before: { type: "object", additionalProperties: true, nullable: true },
    after: { type: "object", additionalProperties: true, nullable: true },
    request_id: nullableString(),
    at: { type: "string", format: "date-time" },
  },
  [
    "id",
    "tenant_id",
    "actor",
    "action",
    "entity_type",
    "entity_id",
    "before",
    "after",
    "request_id",
    "at",
  ],
);

const listOf = (name: string, item: JsonSchema, extra: Record<string, JsonSchema>): JsonSchema =>
  objectSchema({ mode: { type: "string", enum: ["sim"] }, data: arrayOf(item, name), ...extra }, [
    "mode",
    "data",
  ]);

export const COMPONENTS: Record<string, JsonSchema> = {
  Error: error,
  Balance: balance,
  Account: account,
  AccountWithBalance: objectSchema({ account, balance }, ["account", "balance"]),
  AccountList: listOf(
    "one per account",
    objectSchema({ account, balance }, ["account", "balance"]),
    {},
  ),
  BalanceResponse: objectSchema(
    { balance, version: stringSchema("optimistic-lock version of the balance row") },
    ["balance", "version"],
  ),
  Transaction: transaction,
  TransactionList: listOf("one per transaction", transaction, {
    next_cursor: nullableString("keyset cursor for the next page"),
  }),
  Hold: hold,
  HoldList: listOf("one per hold", hold, {}),
  HoldResponse: objectSchema({ mode: stringSchema(), hold, balance }, ["mode", "hold", "balance"]),
  Payout: payout,
  PayoutResponse: objectSchema(
    { mode: stringSchema(), payout, balance: { ...balance, nullable: true } },
    ["mode", "payout", "balance"],
  ),
  PayoutDetail: objectSchema(
    {
      mode: stringSchema(),
      payout,
      events: arrayOf(
        { type: "object", additionalProperties: true },
        "append-only payout transitions",
      ),
    },
    ["mode", "payout", "events"],
  ),
  PayoutList: listOf("one per payout", payout, {}),
  Scenario: scenario,
  ScenarioResponse: objectSchema({ mode: stringSchema(), scenario }, ["mode", "scenario"]),
  ScenarioList: listOf("one per scenario", scenario, {}),
  Statement: statement,
  Eod: eodEntry,
  EodResponse: objectSchema({ mode: stringSchema(), eod: eodEntry }, ["mode", "eod"]),
  EodList: listOf("one per closed business date", eodEntry, {
    account_id: stringSchema(),
    last_closed_business_date: nullableString(),
  }),
  Subscription: subscription,
  SubscriptionResponse: objectSchema(
    { mode: stringSchema(), subscription, secret: nullableString("returned once at registration") },
    ["mode", "subscription", "secret"],
  ),
  SubscriptionList: listOf("one per subscription", subscription, {}),
  Delivery: delivery,
  DeliveryList: listOf("one per delivery", delivery, {}),
  DeliveryResponse: objectSchema({ mode: stringSchema(), delivery }, ["mode", "delivery"]),
  EventList: listOf(
    "one per outbox event",
    objectSchema(
      {
        seq: { type: "integer" },
        id: { type: "string", format: "uuid" },
        type: stringSchema(),
        account_id: nullableString(),
        data: { type: "object", additionalProperties: true },
        created_at: { type: "string", format: "date-time" },
      },
      ["seq", "id", "type", "account_id", "data", "created_at"],
    ),
    { next_cursor: nullableString(), has_more: { type: "boolean" } },
  ),
  AuditList: listOf("newest first", auditEntry, {}),
  ClockState: objectSchema(
    {
      frozen: { type: "boolean" },
      base: nullableString(),
      now: { type: "string", format: "date-time" },
    },
    ["frozen", "base", "now"],
  ),
  OpsUser: opsUser,
  OpsPrincipal: opsPrincipal,
  LoginResponse: objectSchema(
    {
      mode: stringSchema(),
      token: stringSchema("ops_<prefix>_<secret>; shown once"),
      expires_at: { type: "string", format: "date-time" },
      user: opsUser,
    },
    ["mode", "token", "expires_at", "user"],
  ),
  MessageResponse: objectSchema({ mode: stringSchema(), logged_out: { type: "boolean" } }, [
    "mode",
    "logged_out",
  ]),
  VersionInfo: objectSchema(
    {
      mode: stringSchema(),
      service: stringSchema(),
      version: stringSchema(),
      commit: stringSchema(),
      schema_version: nullableString(),
      node: stringSchema(),
    },
    ["mode", "service", "version", "commit", "schema_version", "node"],
  ),
};

const balanceOrError = { status: 200 as const, schema: "BalanceResponse" };

/** Every route the server registers, in one table. */
export const ROUTES: readonly ApiOperation[] = [
  {
    method: "GET",
    path: "/health",
    operationId: "getHealth",
    summary: "Liveness; no database",
    tag: "system",
    auth: "none",
    success: { status: 200, schema: "VersionInfo" },
  },
  {
    method: "GET",
    path: "/ready",
    operationId: "getReady",
    summary: "Readiness; 503 when the database is down",
    tag: "system",
    auth: "none",
    success: { status: 200, schema: "VersionInfo" },
    errors: [503],
  },
  {
    method: "GET",
    path: "/version",
    operationId: "getVersion",
    summary: "Version, commit, schema version and node",
    tag: "system",
    auth: "none",
    success: { status: 200, schema: "VersionInfo" },
  },
  {
    method: "GET",
    path: "/v1/meta",
    operationId: "getMeta",
    summary: "Mode, version and available failure scenarios",
    tag: "system",
    auth: "none",
    success: { status: 200, schema: "VersionInfo" },
  },

  {
    method: "POST",
    path: "/v1/accounts",
    operationId: "createAccount",
    summary: "Open a corporate AED account",
    tag: "accounts",
    auth: "api-key",
    scope: "accounts:write",
    request: objectSchema({ product_code: stringSchema() }, []),
    success: { status: 201, schema: "AccountWithBalance" },
  },
  {
    method: "GET",
    path: "/v1/accounts",
    operationId: "listAccounts",
    summary: "The tenant's accounts with balances",
    tag: "accounts",
    auth: "api-key",
    scope: "accounts:read",
    success: { status: 200, schema: "AccountList" },
  },
  {
    method: "GET",
    path: "/v1/accounts/:id",
    operationId: "getAccount",
    summary: "One account with its balance",
    tag: "accounts",
    auth: "api-key",
    scope: "accounts:read",
    success: { status: 200, schema: "AccountWithBalance" },
    errors: [404],
  },
  {
    method: "GET",
    path: "/v1/accounts/:id/balance",
    operationId: "getBalance",
    summary: "Available, pending, held and ledger",
    tag: "accounts",
    auth: "api-key",
    scope: "accounts:read",
    success: balanceOrError,
    errors: [404],
  },
  {
    method: "GET",
    path: "/v1/accounts/:id/transactions",
    operationId: "listTransactions",
    summary: "Posted movements, keyset paginated",
    tag: "accounts",
    auth: "api-key",
    scope: "accounts:read",
    success: { status: 200, schema: "TransactionList" },
  },
  {
    method: "POST",
    path: "/v1/accounts/:id/credits:simulate",
    operationId: "simulateCredit",
    summary: "Post a simulated incoming credit",
    tag: "accounts",
    auth: "api-key",
    scope: "accounts:write",
    request: objectSchema(
      {
        amount: amountSchema(),
        reference: stringSchema(),
        end_to_end_id: stringSchema(),
        value_date: stringSchema(),
        remitter: objectSchema(
          { name: stringSchema(), iban: stringSchema(), bic: stringSchema() },
          ["name"],
        ),
      },
      ["amount"],
    ),
    success: { status: 200, schema: "BalanceResponse" },
    errors: [404, 422],
  },

  {
    method: "POST",
    path: "/v1/payouts",
    operationId: "createPayout",
    summary: "Create a local AED payout and reserve it",
    tag: "payouts",
    auth: "api-key",
    scope: "payouts:write",
    request: objectSchema(
      {
        account_id: stringSchema(),
        amount: amountSchema(),
        currency: { type: "string", enum: ["AED"] },
        reference: stringSchema(),
        end_to_end_id: stringSchema(),
        value_date: stringSchema(),
        beneficiary,
      },
      ["account_id", "amount", "beneficiary"],
    ),
    success: { status: 201, schema: "PayoutResponse" },
    errors: [404, 409, 422],
  },
  {
    method: "GET",
    path: "/v1/payouts",
    operationId: "listPayouts",
    summary: "Payouts, optionally filtered by status",
    tag: "payouts",
    auth: "api-key",
    scope: "payouts:read",
    success: { status: 200, schema: "PayoutList" },
  },
  {
    method: "GET",
    path: "/v1/payouts/:id",
    operationId: "getPayout",
    summary: "One payout with its append-only events",
    tag: "payouts",
    auth: "api-key",
    scope: "payouts:read",
    success: { status: 200, schema: "PayoutDetail" },
    errors: [404],
  },
  {
    method: "POST",
    path: "/v1/payouts/:id/cancel",
    operationId: "cancelPayout",
    summary: "Cancel before submission and release the hold",
    tag: "payouts",
    auth: "api-key",
    scope: "payouts:write",
    success: { status: 200, schema: "PayoutResponse" },
    errors: [404, 409],
  },
  {
    method: "POST",
    path: "/v1/accounts/:id/holds",
    operationId: "createHold",
    summary: "Reserve available balance without moving the ledger",
    tag: "payouts",
    auth: "api-key",
    scope: "accounts:write",
    request: objectSchema(
      {
        amount: amountSchema(),
        reason: stringSchema(),
        reference: stringSchema(),
        expires_at: stringSchema(),
      },
      ["amount", "reason"],
    ),
    success: { status: 201, schema: "HoldResponse" },
    errors: [404, 422],
  },
  {
    method: "GET",
    path: "/v1/accounts/:id/holds",
    operationId: "listHolds",
    summary: "Holds for one account",
    tag: "payouts",
    auth: "api-key",
    scope: "accounts:read",
    success: { status: 200, schema: "HoldList" },
  },
  {
    method: "DELETE",
    path: "/v1/holds/:id",
    operationId: "releaseHold",
    summary: "Release a hold; replay-safe",
    tag: "payouts",
    auth: "api-key",
    scope: "accounts:write",
    success: { status: 200, schema: "HoldResponse" },
    errors: [404, 409],
  },

  {
    method: "GET",
    path: "/v1/accounts/:id/statement",
    operationId: "getStatementRange",
    summary: "Statement for a booking-date range in JSON, CSV or MT940",
    tag: "statements",
    auth: "api-key",
    scope: "accounts:read",
    success: {
      status: 200,
      schema: "Statement",
      contentType: "application/json, text/csv, text/plain",
    },
    errors: [404, 422],
  },
  {
    method: "GET",
    path: "/v1/accounts/:id/statements/:date/:format",
    operationId: "getDailyStatement",
    summary: "One business day in one format",
    tag: "statements",
    auth: "api-key",
    scope: "accounts:read",
    success: {
      status: 200,
      schema: "Statement",
      contentType: "application/json, text/csv, text/plain",
    },
    errors: [404, 422],
  },
  {
    method: "POST",
    path: "/v1/accounts/:id/eod/close",
    operationId: "closeEod",
    summary: "Close the next UAE business day and snapshot it",
    tag: "statements",
    auth: "api-key",
    scope: "accounts:write",
    request: objectSchema({ business_date: stringSchema() }, []),
    success: { status: 201, schema: "EodResponse" },
    errors: [404, 409, 422],
  },
  {
    method: "GET",
    path: "/v1/accounts/:id/eod",
    operationId: "listEod",
    summary: "EOD state and recent snapshots",
    tag: "statements",
    auth: "api-key",
    scope: "accounts:read",
    success: { status: 200, schema: "EodList" },
  },
  {
    method: "GET",
    path: "/v1/accounts/:id/eod/:date",
    operationId: "getEod",
    summary: "One immutable EOD snapshot",
    tag: "statements",
    auth: "api-key",
    scope: "accounts:read",
    success: { status: 200, schema: "EodResponse" },
    errors: [404],
  },

  {
    method: "POST",
    path: "/v1/webhooks",
    operationId: "createSubscription",
    summary: "Register a receiver; the signing secret is returned once",
    tag: "webhooks",
    auth: "api-key",
    scope: "webhooks:write",
    request: objectSchema(
      { url: stringSchema(), events: arrayOf(stringSchema()), description: stringSchema() },
      ["url", "events"],
    ),
    success: { status: 201, schema: "SubscriptionResponse" },
    errors: [422],
  },
  {
    method: "GET",
    path: "/v1/webhooks",
    operationId: "listSubscriptions",
    summary: "Tenant subscriptions, never the secret",
    tag: "webhooks",
    auth: "api-key",
    scope: "webhooks:read",
    success: { status: 200, schema: "SubscriptionList" },
  },
  {
    method: "DELETE",
    path: "/v1/webhooks/:id",
    operationId: "disableSubscription",
    summary: "Disable a subscription, keeping its history",
    tag: "webhooks",
    auth: "api-key",
    scope: "webhooks:write",
    success: { status: 200, schema: "SubscriptionResponse" },
    errors: [404],
  },
  {
    method: "GET",
    path: "/v1/webhooks/:id/deliveries",
    operationId: "listDeliveries",
    summary: "Delivery attempts and outcomes",
    tag: "webhooks",
    auth: "api-key",
    scope: "webhooks:read",
    success: { status: 200, schema: "DeliveryList" },
  },
  {
    method: "GET",
    path: "/v1/events",
    operationId: "pullEvents",
    summary: "Cursor pull of outbox events",
    tag: "webhooks",
    auth: "api-key",
    scope: "events:read",
    success: { status: 200, schema: "EventList" },
  },
  {
    method: "POST",
    path: "/v1/outbox/dispatch",
    operationId: "dispatchOutbox",
    summary: "Drain this tenant's due deliveries",
    tag: "webhooks",
    auth: "api-key",
    scope: "webhooks:write",
    success: { status: 200, schema: "EventList" },
  },

  {
    method: "POST",
    path: "/v1/scenarios",
    operationId: "armScenario",
    summary: "Arm a failure scenario against one payout",
    tag: "scenarios",
    auth: "api-key",
    scope: "payouts:write",
    request: objectSchema(
      {
        payout_id: stringSchema(),
        kind: { type: "string", enum: ["underpaid", "sanctions_hold", "bank_timeout", "returned"] },
        shortfall: amountSchema(),
      },
      ["payout_id", "kind"],
    ),
    success: { status: 201, schema: "ScenarioResponse" },
    errors: [400, 404, 409],
  },
  {
    method: "GET",
    path: "/v1/scenarios",
    operationId: "listScenarios",
    summary: "Tenant scenarios, newest first",
    tag: "scenarios",
    auth: "api-key",
    scope: "payouts:read",
    success: { status: 200, schema: "ScenarioList" },
  },
  {
    method: "DELETE",
    path: "/v1/scenarios/:id",
    operationId: "disarmScenario",
    summary: "Disarm an armed scenario",
    tag: "scenarios",
    auth: "api-key",
    scope: "payouts:write",
    success: { status: 200, schema: "ScenarioResponse" },
    errors: [404, 409],
  },

  {
    method: "POST",
    path: "/ops/v1/accounts/:id/simulate-credit",
    operationId: "opsSimulateCredit",
    summary: "Ops: post a simulated credit",
    tag: "ops",
    auth: "ops-session",
    request: objectSchema(
      {
        amount: amountSchema(),
        reference: stringSchema(),
        value_date: stringSchema(),
        remitter: objectSchema(
          { name: stringSchema(), iban: stringSchema(), bic: stringSchema() },
          ["name"],
        ),
      },
      ["amount"],
    ),
    success: { status: 200, schema: "BalanceResponse" },
    errors: [404, 422],
  },
  {
    method: "POST",
    path: "/ops/v1/payouts/:id/advance",
    operationId: "opsAdvancePayout",
    summary: "Ops: advance a payout one legal step",
    tag: "ops",
    auth: "ops-session",
    request: objectSchema(
      {
        to: {
          type: "string",
          enum: [
            "validated",
            "submitted",
            "accepted",
            "settled",
            "returned",
            "failed",
            "cancelled",
          ],
        },
      },
      [],
    ),
    success: { status: 200, schema: "PayoutDetail" },
    errors: [404, 409, 423, 504],
  },
  {
    method: "POST",
    path: "/ops/v1/payouts/:id/reverse",
    operationId: "opsReversePayout",
    summary: "Ops: return settled funds with a reversal credit",
    tag: "ops",
    auth: "ops-session",
    success: { status: 200, schema: "PayoutDetail" },
    errors: [404, 409],
  },
  {
    method: "POST",
    path: "/ops/v1/outbox/dispatch",
    operationId: "opsDispatchOutbox",
    summary: "Ops: drain due deliveries across tenants",
    tag: "ops",
    auth: "ops-session",
    success: { status: 200, schema: "EventList" },
  },
  {
    method: "POST",
    path: "/ops/v1/webhooks/deliveries/:id/replay",
    operationId: "opsReplayDelivery",
    summary: "Ops: re-arm a failed or dead delivery",
    tag: "ops",
    auth: "ops-session",
    success: { status: 200, schema: "DeliveryResponse" },
    errors: [404],
  },
  {
    method: "POST",
    path: "/ops/v1/scenarios",
    operationId: "opsArmScenario",
    summary: "Ops: arm a scenario for any payout",
    tag: "ops",
    auth: "ops-session",
    request: objectSchema(
      {
        payout_id: stringSchema(),
        kind: { type: "string", enum: ["underpaid", "sanctions_hold", "bank_timeout", "returned"] },
        shortfall: amountSchema(),
      },
      ["payout_id", "kind"],
    ),
    success: { status: 201, schema: "ScenarioResponse" },
    errors: [400, 404, 409],
  },
  {
    method: "GET",
    path: "/ops/v1/scenarios",
    operationId: "opsListScenarios",
    summary: "Ops: list scenarios across tenants",
    tag: "ops",
    auth: "ops-session",
    success: { status: 200, schema: "ScenarioList" },
  },
  {
    method: "DELETE",
    path: "/ops/v1/scenarios/:id",
    operationId: "opsDisarmScenario",
    summary: "Ops: disarm any tenant's scenario",
    tag: "ops",
    auth: "ops-session",
    success: { status: 200, schema: "ScenarioResponse" },
    errors: [404, 409],
  },
  {
    method: "GET",
    path: "/ops/v1/clock",
    operationId: "opsGetClock",
    summary: "Ops: read the simulator clock",
    tag: "ops",
    auth: "ops-session",
    success: { status: 200, schema: "ClockState" },
  },
  {
    method: "POST",
    path: "/ops/v1/clock/freeze",
    operationId: "opsFreezeClock",
    summary: "Ops: freeze the clock at an instant",
    tag: "ops",
    auth: "ops-session",
    request: objectSchema({ at: stringSchema() }, []),
    success: { status: 200, schema: "ClockState" },
  },
  {
    method: "POST",
    path: "/ops/v1/clock/step",
    operationId: "opsStepClock",
    summary: "Ops: step the clock forward",
    tag: "ops",
    auth: "ops-session",
    request: objectSchema(
      {
        seconds: { type: "integer" },
        minutes: { type: "integer" },
        hours: { type: "integer" },
        days: { type: "integer" },
      },
      [],
    ),
    success: { status: 200, schema: "ClockState" },
  },
  {
    method: "POST",
    path: "/ops/v1/clock/resume",
    operationId: "opsResumeClock",
    summary: "Ops: resume the system clock",
    tag: "ops",
    auth: "ops-session",
    success: { status: 200, schema: "ClockState" },
  },
  {
    method: "POST",
    path: "/ops/v1/auth/login",
    operationId: "opsLogin",
    summary: "Exchange email + password for a session token",
    tag: "ops-auth",
    auth: "none",
    request: objectSchema({ email: stringSchema(), password: stringSchema() }, [
      "email",
      "password",
    ]),
    success: { status: 200, schema: "LoginResponse" },
    errors: [401],
  },
  {
    method: "POST",
    path: "/ops/v1/auth/logout",
    operationId: "opsLogout",
    summary: "Revoke the calling session",
    tag: "ops-auth",
    auth: "ops-session",
    success: { status: 200, schema: "MessageResponse" },
  },
  {
    method: "GET",
    path: "/ops/v1/auth/me",
    operationId: "opsMe",
    summary: "Caller identity, role and channel",
    tag: "ops-auth",
    auth: "ops-session",
    success: { status: 200, schema: "OpsPrincipal" },
  },
  {
    method: "GET",
    path: "/ops/v1/accounts",
    operationId: "opsListAccounts",
    summary: "Ops: every tenant's accounts",
    tag: "ops",
    auth: "ops-session",
    success: { status: 200, schema: "AccountList" },
  },
  {
    method: "GET",
    path: "/ops/v1/payouts",
    operationId: "opsListPayouts",
    summary: "Ops: every tenant's payouts",
    tag: "ops",
    auth: "ops-session",
    success: { status: 200, schema: "PayoutList" },
  },
  {
    method: "GET",
    path: "/ops/v1/audit",
    operationId: "opsListAudit",
    summary: "Ops: recent audit rows across tenants",
    tag: "ops",
    auth: "ops-session",
    success: { status: 200, schema: "AuditList" },
  },
  {
    method: "GET",
    path: "/ops/v1/webhooks/deliveries",
    operationId: "opsListDeliveries",
    summary: "Ops: recent deliveries across tenants",
    tag: "ops",
    auth: "ops-session",
    success: { status: 200, schema: "DeliveryList" },
  },

  {
    method: "GET",
    path: "/ops",
    operationId: "opsRedirect",
    summary: "Redirect to the ops console",
    tag: "console",
    auth: "none",
    success: { status: 302 },
  },
  {
    method: "GET",
    path: "/ops/console",
    operationId: "opsConsole",
    summary: "Ops console HTML page",
    tag: "console",
    auth: "none",
    success: { status: 200, contentType: "text/html" },
  },
  {
    method: "GET",
    path: "/ops/v1/console/info",
    operationId: "opsConsoleInfo",
    summary: "Console paths and version",
    tag: "console",
    auth: "none",
    success: { status: 200, schema: "VersionInfo" },
  },
];

const ERROR_DESCRIPTIONS: Record<number, string> = {
  302: "redirect",
  400: "validation_error",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "rule refused",
  423: "held or restricted",
  500: "internal_error",
  503: "not_ready",
  504: "rail_timeout",
};

export function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z_]+)/g, "{$1}");
}

function pathParameters(path: string): string[] {
  return [...toOpenApiPath(path).matchAll(/\{([A-Za-z_]+)\}/g)].map((match) => match[1] ?? "");
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const operation of ROUTES) {
    const openApiPath = toOpenApiPath(operation.path);
    const requiresKey =
      operation.method !== "GET" &&
      !IDEMPOTENCY_EXEMPT.has(`${operation.method} ${operation.path}`);

    const parameters: Record<string, unknown>[] = pathParameters(openApiPath).map((name) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    }));

    if (requiresKey) {
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: true,
        description: "1-255 printable ASCII characters; same key + same body replays",
        schema: { type: "string", minLength: 1, maxLength: 255 },
      });
    }

    const statuses = new Set<number>([
      operation.success.status,
      ...(operation.success.status === 302 ? [] : [400, 401, 500]),
      ...(operation.errors ?? []),
    ]);

    const responses: Record<string, unknown> = {};
    for (const status of [...statuses].sort((left, right) => left - right)) {
      const description =
        status === operation.success.status
          ? "success"
          : (ERROR_DESCRIPTIONS[status] ?? `http_${status}`);

      if (status === operation.success.status && operation.success.contentType !== undefined) {
        responses[String(status)] = {
          description,
          content: {
            [operation.success.contentType.split(",")[0]?.trim() ?? "application/json"]: {},
          },
        };
        continue;
      }

      const schema =
        status === operation.success.status
          ? operation.success.schema
          : status === 302 || status === 503
            ? undefined
            : "Error";

      responses[String(status)] =
        schema === undefined
          ? { description }
          : {
              description,
              content: {
                "application/json": { schema: { $ref: `#/components/schemas/${schema}` } },
              },
            };
    }

    const entry: Record<string, unknown> = {
      operationId: operation.operationId,
      summary: operation.summary,
      tags: [operation.tag],
      parameters,
      responses,
    };

    if (operation.auth === "api-key") {
      entry.security = [{ bearerApiKey: [] }];
      entry["x-required-scope"] = operation.scope ?? null;
    }
    if (operation.auth === "ops-session") {
      entry.security = [{ opsSession: [] }];
      entry["x-required-role"] = "operator for writes, viewer for reads";
    }
    if (requiresKey) {
      entry["x-idempotency-key"] = "required";
    }
    if (operation.request !== undefined) {
      entry.requestBody = {
        required: true,
        content: { "application/json": { schema: operation.request } },
      };
    }

    paths[openApiPath] ??= {};
    paths[openApiPath][operation.method.toLowerCase()] = entry;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "S2 — Bank Simulator API",
      version: API_VERSION,
      description:
        "Simulated corporate AED bank: ledger, holds, payouts, statements, EOD, signed webhooks, failure scenarios and the ops console. Every response carries mode=sim; the data is synthetic.",
    },
    servers: [
      { url: "https://sim-s2-bank.vercel.app", description: "live demo" },
      { url: "http://localhost:4002", description: "local" },
    ],
    tags: [
      { name: "system" },
      { name: "accounts" },
      { name: "payouts" },
      { name: "statements" },
      { name: "webhooks" },
      { name: "scenarios" },
      { name: "ops" },
      { name: "ops-auth" },
      { name: "console" },
    ],
    paths,
    components: {
      securitySchemes: {
        bearerApiKey: {
          type: "http",
          scheme: "bearer",
          description: "Tenant API key: sk_sim_<prefix>_<secret>",
        },
        opsSession: {
          type: "http",
          scheme: "bearer",
          description: "Ops session from POST /ops/v1/auth/login: ops_<prefix>_<secret>",
        },
      },
      schemas: COMPONENTS,
    },
  };
}
