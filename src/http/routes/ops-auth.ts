import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { loginOpsUser, logoutOpsSession } from "../../application/ops-sessions.js";
import type { Env } from "../../config/env.js";
import { MODE } from "../../domain/constants.js";
import { requireOps, serializeOpsPrincipal } from "../ops-auth.js";

export interface OpsAuthRouteDeps {
  db: Pool;
  env: Env;
}

const loginBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
});

function serializeUser(user: {
  id: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
  createdAt: string;
  lastLoginAt: string | null;
}) {
  return {
    id: user.id,
    email: user.email,
    display_name: user.displayName,
    role: user.role,
    status: user.status,
    created_at: user.createdAt,
    last_login_at: user.lastLoginAt,
  };
}

/**
 * Operator identity. Login/logout are deliberately exempt from `Idempotency-Key`:
 * a second login must mint a second session, and a replay must not return a token
 * that has already been revoked.
 */
export function registerOpsAuthRoutes(app: FastifyInstance, deps: OpsAuthRouteDeps): void {
  app.post("/ops/v1/auth/login", async (request) => {
    const body = loginBody.parse(request.body ?? {});
    const result = await loginOpsUser(deps.db, {
      email: body.email,
      password: body.password,
      pepper: deps.env.apiKeyPepper,
      ttlHours: deps.env.opsSessionTtlHours,
    });

    return {
      mode: MODE,
      token: result.token,
      expires_at: result.expiresAt,
      user: serializeUser(result.user),
    };
  });

  app.post("/ops/v1/auth/logout", async (request) => {
    const principal = await requireOps(deps, request);
    if (principal.sessionId !== null) {
      await logoutOpsSession(deps.db, principal.sessionId);
    }
    return { mode: MODE, logged_out: true };
  });

  app.get("/ops/v1/auth/me", async (request) => {
    const principal = await requireOps(deps, request);
    return { mode: MODE, user: serializeOpsPrincipal(principal) };
  });
}
