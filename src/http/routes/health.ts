import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { currentSchemaVersion } from "../../adapters/db/migrate.js";
import type { Env } from "../../config/env.js";
import { MODE } from "../../domain/constants.js";
import { SCENARIO_DESCRIPTIONS, SCENARIO_KINDS } from "../../domain/scenario.js";

export function registerHealthRoutes(app: FastifyInstance, deps: { env: Env; db: Pool }): void {
  const { env, db } = deps;

  app.get("/health", async () => ({ status: "ok", mode: MODE }));

  app.get("/ready", async (request, reply) => {
    try {
      await db.query("SELECT 1");
      return { status: "ready", mode: MODE };
    } catch (error) {
      request.log.error({ err: error }, "readiness check failed");
      return reply.status(503).send({ status: "not_ready", mode: MODE });
    }
  });

  app.get("/version", async () => {
    let schemaVersion: string | null = null;
    try {
      schemaVersion = await currentSchemaVersion(db);
    } catch {
      schemaVersion = null;
    }
    return {
      mode: MODE,
      service: "sim-s2-bank",
      version: env.version,
      commit: env.gitCommit,
      schema_version: schemaVersion,
      node: process.version,
    };
  });

  app.get("/v1/meta", async () => ({
    mode: MODE,
    version: env.version,
    server_time: new Date().toISOString(),
    scenarios: SCENARIO_KINDS.map((kind) => ({
      kind,
      description: SCENARIO_DESCRIPTIONS[kind],
    })),
  }));
}
