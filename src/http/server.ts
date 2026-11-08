import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { createPool } from "../adapters/db/pool.js";
import { adjustableClock } from "../config/clock.js";
import type { Env } from "../config/env.js";
import { errorBody, handleError } from "./errors.js";
import { registerAccountRoutes } from "./routes/accounts.js";
import { registerConsoleRoutes } from "./routes/console.js";
import { registerEodRoutes } from "./routes/eod.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerOpsAuthRoutes } from "./routes/ops-auth.js";
import { registerOpsReadRoutes } from "./routes/ops-read.js";
import { registerOpsRoutes } from "./routes/ops.js";
import { registerPayoutRoutes } from "./routes/payouts.js";
import { registerScenarioRoutes } from "./routes/scenarios.js";
import { registerStatementRoutes } from "./routes/statements.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";

export interface RouteRegistration {
  methods: readonly string[];
  url: string;
}

export interface BuildServerOptions {
  /** Called for every registered route; used by the contract tests (S2-11). */
  onRoute?: (route: RouteRegistration) => void;
}

export function buildServer(env: Env, options: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger:
      env.nodeEnv === "test"
        ? false
        : { level: env.logLevel, redact: ["req.headers.authorization", "req.headers.x-ops-token"] },
    genReqId: (request) => {
      const incoming = request.headers["x-request-id"];
      return typeof incoming === "string" && incoming.length > 0 ? incoming : randomUUID();
    },
    bodyLimit: 1_048_576,
  });

  if (options.onRoute !== undefined) {
    const onRoute = options.onRoute;
    app.addHook("onRoute", (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      onRoute({ methods, url: route.url });
    });
  }

  const db = createPool(env.databaseUrl);
  const clock = adjustableClock(env.simClock);

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.setErrorHandler(handleError);
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send(errorBody("not_found", "route not found", request.id));
  });

  app.addHook("onClose", async () => {
    await db.end();
  });

  registerHealthRoutes(app, { env, db });
  registerAccountRoutes(app, { db, env, clock });
  registerPayoutRoutes(app, { db, env, clock });
  registerStatementRoutes(app, { db, env, clock });
  registerEodRoutes(app, { db, env, clock });
  registerWebhookRoutes(app, { db, env });
  registerScenarioRoutes(app, { db, env, clock });
  registerOpsAuthRoutes(app, { db, env });
  registerOpsReadRoutes(app, { db, env });
  registerConsoleRoutes(app, { env });
  registerOpsRoutes(app, { db, env, clock });

  return app;
}
