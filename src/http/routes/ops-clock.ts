import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { AdjustableClock } from "../../config/clock.js";
import type { Env } from "../../config/env.js";
import { requireOps } from "../ops-auth.js";

export interface OpsClockRouteDeps {
  db: Pool;
  env: Env;
  clock: AdjustableClock;
}

const freezeBody = z.object({
  at: z.string().datetime({ offset: true }).optional(),
});

const stepBody = z
  .object({
    seconds: z.number().positive().max(86_400).optional(),
    minutes: z.number().positive().max(1_440).optional(),
    hours: z.number().positive().max(720).optional(),
    days: z.number().positive().max(30).optional(),
  })
  .refine(
    (value) =>
      value.seconds !== undefined ||
      value.minutes !== undefined ||
      value.hours !== undefined ||
      value.days !== undefined,
    { message: "provide seconds, minutes, hours or days" },
  );

/**
 * Control-plane clock for deterministic demos: freeze at an instant, step forward,
 * or resume the system clock. These routes are intentionally exempt from
 * `Idempotency-Key`; stepping twice must step twice, and the clock itself is the
 * replay domain.
 */
export function registerOpsClockRoutes(app: FastifyInstance, deps: OpsClockRouteDeps): void {
  const { db, env, clock } = deps;

  function clockBody() {
    return { mode: "sim" as const, clock: clock.state() };
  }

  app.get("/ops/v1/clock", async (request) => {
    await requireOps({ db, env }, request);
    return clockBody();
  });

  app.post("/ops/v1/clock/freeze", async (request) => {
    await requireOps({ db, env }, request, { write: true });

    const body = freezeBody.parse(request.body ?? {});
    clock.freeze(body.at);
    return clockBody();
  });

  app.post("/ops/v1/clock/step", async (request) => {
    await requireOps({ db, env }, request, { write: true });

    const body = stepBody.parse(request.body ?? {});
    const milliseconds =
      (body.seconds ?? 0) * 1_000 +
      (body.minutes ?? 0) * 60_000 +
      (body.hours ?? 0) * 3_600_000 +
      (body.days ?? 0) * 86_400_000;

    clock.step(milliseconds);
    return clockBody();
  });

  app.post("/ops/v1/clock/resume", async (request) => {
    await requireOps({ db, env }, request, { write: true });
    clock.resume();
    return clockBody();
  });
}
