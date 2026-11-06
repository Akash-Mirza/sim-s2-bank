import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { DomainError } from "../domain/errors.js";

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    request_id: string;
    details: unknown;
  };
}

export function errorBody(
  code: string,
  message: string,
  requestId: string,
  details: unknown = null,
): ErrorBody {
  return { error: { code, message, request_id: requestId, details } };
}

export function handleError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof DomainError) {
    return reply
      .status(error.statusCode)
      .send(errorBody(error.code, error.message, request.id, error.details));
  }

  if (error instanceof ZodError) {
    return reply
      .status(400)
      .send(errorBody("validation_error", "request validation failed", request.id, error.issues));
  }

  const statusCode =
    typeof error === "object" && error !== null && "statusCode" in error
      ? (error as { statusCode?: number }).statusCode
      : undefined;

  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
    const message = error instanceof Error ? error.message : "request failed";
    return reply.status(statusCode).send(errorBody("validation_error", message, request.id));
  }

  request.log.error({ err: error }, "unhandled request error");
  return reply
    .status(500)
    .send(errorBody("internal_error", "unexpected simulator error", request.id));
}
