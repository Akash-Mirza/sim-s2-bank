import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { Env } from "../config/env.js";
import { createPool } from "../adapters/db/pool.js";
import { errorBody, handleError } from "./errors.js";
import { registerHealthRoutes } from "./routes/health.js";

export function buildServer(env: Env): FastifyInstance {
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

  const db = createPool(env.databaseUrl);

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

  return app;
}
