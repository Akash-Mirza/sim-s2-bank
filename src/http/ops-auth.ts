import type { FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { type OpsPrincipal, resolveOpsSession } from "../application/ops-sessions.js";
import type { Env } from "../config/env.js";
import { DomainError, forbidden } from "../domain/errors.js";

export interface OpsAuthDeps {
  db: Pool;
  env: Env;
}

export interface OpsAuthOptions {
  /** Reject `viewer` sessions for a state-changing route. */
  write?: boolean;
  /** Require `admin` (user management). */
  admin?: boolean;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Authorize an `/ops/v1` call.
 *
 * Order matters: a Bearer ops session is the real identity and works in
 * production. The shared `x-ops-token` is a local-development shortcut only —
 * `ENABLE_DEV_OPS` cannot be true when `NODE_ENV=production`, so it can never be
 * used against a deployed simulator.
 */
export async function requireOps(
  deps: OpsAuthDeps,
  request: FastifyRequest,
  options: OpsAuthOptions = {},
): Promise<OpsPrincipal> {
  const authorization = headerValue(request.headers.authorization);

  let principal: OpsPrincipal | null = null;

  if (authorization?.startsWith("Bearer ops_")) {
    principal = await resolveOpsSession(deps.db, deps.env.apiKeyPepper, authorization);
    if (principal === null) {
      throw new DomainError("unauthorized", "invalid or expired ops session", 401);
    }
  } else if (deps.env.enableDevOps) {
    const presented = headerValue(request.headers["x-ops-token"]);
    if (presented !== undefined && presented === deps.env.opsDevToken) {
      principal = {
        sessionId: null,
        userId: null,
        email: "dev-ops",
        displayName: "Local dev ops",
        role: "admin",
        via: "dev-token",
      };
    }
  }

  if (principal === null) {
    throw new DomainError("unauthorized", "ops session required", 401);
  }

  if (options.write === true && principal.role === "viewer") {
    throw forbidden("viewer ops sessions are read-only");
  }
  if (options.admin === true && principal.role !== "admin") {
    throw forbidden("admin role required");
  }

  return principal;
}

/** The audit actor for an ops action: a named operator, or the local dev token. */
export function opsActor(principal: OpsPrincipal): string {
  return principal.via === "dev-token" ? "ops:dev" : `ops:${principal.email}`;
}

export function serializeOpsPrincipal(principal: OpsPrincipal) {
  return {
    session_id: principal.sessionId,
    user_id: principal.userId,
    email: principal.email,
    display_name: principal.displayName,
    role: principal.role,
    via: principal.via,
  };
}
