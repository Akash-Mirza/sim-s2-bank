import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/config/env.js";
import { renderOpenApiYaml, renderTypeScript } from "../../src/contracts/codegen.js";
import type { JsonSchema } from "../../src/contracts/schema.js";
import {
  COMPONENTS,
  IDEMPOTENCY_EXEMPT,
  ROUTES,
  buildOpenApiDocument,
  toOpenApiPath,
} from "../../src/contracts/spec.js";
import { buildServer } from "../../src/http/server.js";

const KNOWN_SCOPES = new Set([
  "accounts:read",
  "accounts:write",
  "payouts:read",
  "payouts:write",
  "webhooks:read",
  "webhooks:write",
  "events:read",
]);

function contractEnv(): Env {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    databaseUrl: "postgres://user:pass@localhost:5432/contract",
    logLevel: "silent",
    simClock: undefined,
    enableDevOps: false,
    opsDevToken: "contract-ops-token",
    apiKeyPepper: "0123456789abcdef0123456789abcdef",
    opsSessionTtlHours: 12,
    version: "0.7.0-test",
    gitCommit: "contract",
  };
}

function registeredRoutes(): string[] {
  const routes: string[] = [];
  const app = buildServer(contractEnv(), {
    onRoute: (route) => {
      for (const method of route.methods) {
        if (method === "HEAD" || method === "OPTIONS") continue;
        routes.push(`${method} ${route.url}`);
      }
    },
  });
  void app.close();
  return routes.sort();
}

const specRoutes = ROUTES.map((operation) => `${operation.method} ${operation.path}`).sort();

describe("route table vs the running server", () => {
  it("declares exactly the routes Fastify registers", () => {
    expect(registeredRoutes()).toEqual(specRoutes);
  });

  it("has unique operation ids and no duplicate method+path", () => {
    const ids = ROUTES.map((operation) => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(specRoutes).size).toBe(specRoutes.length);
  });

  it("requires Idempotency-Key on every write except the declared control-plane ticks", () => {
    for (const operation of ROUTES) {
      const key = `${operation.method} ${operation.path}`;
      if (operation.method === "GET") {
        expect(IDEMPOTENCY_EXEMPT.has(key), `${key} is a GET`).toBe(false);
        continue;
      }
      if (IDEMPOTENCY_EXEMPT.has(key)) continue;

      const document = buildOpenApiDocument();
      const entry = (document.paths as Record<string, Record<string, unknown>>)[
        toOpenApiPath(operation.path)
      ]?.[operation.method.toLowerCase()] as {
        parameters?: { name: string; in: string }[];
        responses: Record<string, unknown>;
      };

      expect(
        entry.parameters?.some((parameter) => parameter.name === "Idempotency-Key"),
        `${key} must declare Idempotency-Key`,
      ).toBe(true);
    }
  });

  it("keeps the exempt list to the documented control-plane and auth writes", () => {
    expect([...IDEMPOTENCY_EXEMPT].sort()).toEqual([
      "POST /ops/v1/auth/login",
      "POST /ops/v1/auth/logout",
      "POST /ops/v1/clock/freeze",
      "POST /ops/v1/clock/resume",
      "POST /ops/v1/clock/step",
      "POST /ops/v1/outbox/dispatch",
      "POST /v1/outbox/dispatch",
    ]);
  });
});

describe("operation metadata", () => {
  it("declares a real scope for every API-key route and none for ops", () => {
    for (const operation of ROUTES) {
      if (operation.auth === "api-key") {
        expect(operation.scope, `${operation.operationId}`).toBeDefined();
        expect(KNOWN_SCOPES.has(operation.scope ?? ""), `${operation.scope}`).toBe(true);
      } else {
        expect(operation.scope, `${operation.operationId}`).toBeUndefined();
      }
    }
  });

  it("references only components that exist", () => {
    for (const operation of ROUTES) {
      if (operation.success.schema !== undefined) {
        expect(COMPONENTS[operation.success.schema], operation.operationId).toBeDefined();
      }
    }
  });

  it("describes every component as an object with properties", () => {
    for (const [name, schema] of Object.entries(COMPONENTS)) {
      const typed = schema as JsonSchema;
      expect(typed.type, name).toBe("object");
      expect(Object.keys(typed.properties ?? {}).length, name).toBeGreaterThan(0);
    }
  });
});

describe("generated artifacts", () => {
  const document = buildOpenApiDocument() as {
    openapi: string;
    info: { title: string; version: string };
    paths: Record<
      string,
      Record<string, { operationId?: string; responses?: Record<string, unknown> }>
    >;
    components: { schemas: Record<string, JsonSchema> };
  };

  it("builds an OpenAPI 3.1 document with one entry per route", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(document.info.title).toContain("S2");
    expect(document.info.version).toMatch(/^\d+\.\d+\.\d+/);

    const operations = Object.values(document.paths).flatMap((path) => Object.values(path));
    expect(operations).toHaveLength(ROUTES.length);
    for (const operation of operations) {
      expect(operation.operationId).toBeTruthy();
      expect(Object.keys(operation.responses ?? {}).length).toBeGreaterThan(0);
    }
  });

  it("publishes every component under components.schemas", () => {
    expect(Object.keys(document.components.schemas).sort()).toEqual(Object.keys(COMPONENTS).sort());
  });

  it("keeps openapi.yaml identical to the generator", () => {
    expect(readFileSync("openapi.yaml", "utf8")).toBe(renderOpenApiYaml());
  });

  it("keeps src/contracts/api-types.ts identical to the generator", () => {
    expect(readFileSync("src/contracts/api-types.ts", "utf8")).toBe(renderTypeScript());
  });
});

describe("runtime contract shape", () => {
  it("returns the documented error envelope for an unauthorized read", async () => {
    const app = buildServer(contractEnv());
    try {
      const response = await app.inject({ method: "GET", url: "/v1/accounts" });
      expect(response.statusCode).toBe(401);

      const body = response.json();
      expect(Object.keys(body)).toEqual(["error"]);
      expect(Object.keys(body.error).sort()).toEqual(["code", "details", "message", "request_id"]);
      expect(body.error.code).toBe("unauthorized");
      expect(response.headers["x-request-id"]).toBe(body.error.request_id);
    } finally {
      await app.close();
    }
  });

  it("returns the documented envelope for an unknown route", async () => {
    const app = buildServer(contractEnv());
    try {
      const response = await app.inject({ method: "GET", url: "/v1/does-not-exist" });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("not_found");
    } finally {
      await app.close();
    }
  });
});
