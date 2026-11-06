import { z } from "zod";

const rawEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().min(1).default("0.0.0.0"),
    API_PORT: z.coerce.number().int().positive().max(65535).default(4002),
    DATABASE_URL: z.string().url(),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    SIM_CLOCK: z.string().datetime({ offset: true }).optional(),
    ENABLE_DEV_OPS: z.enum(["true", "false"]).default("true"),
    OPS_DEV_TOKEN: z.string().min(8).default("dev-ops-token"),
    API_KEY_PEPPER: z.string().min(16),
    SERVICE_VERSION: z.string().min(1).default("0.1.0-dev.0"),
    GIT_COMMIT: z.string().min(1).default("dev"),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === "production" && value.ENABLE_DEV_OPS === "true") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ENABLE_DEV_OPS"],
        message: "dev ops endpoints must be disabled in production",
      });
    }
  });

export interface Env {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  simClock: string | undefined;
  enableDevOps: boolean;
  opsDevToken: string;
  apiKeyPepper: string;
  version: string;
  gitCommit: string;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = rawEnvSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid environment: ${detail}`);
  }

  const value = parsed.data;
  return {
    nodeEnv: value.NODE_ENV,
    host: value.HOST,
    port: value.API_PORT,
    databaseUrl: value.DATABASE_URL,
    logLevel: value.LOG_LEVEL,
    simClock: value.SIM_CLOCK,
    enableDevOps: value.ENABLE_DEV_OPS === "true",
    opsDevToken: value.OPS_DEV_TOKEN,
    apiKeyPepper: value.API_KEY_PEPPER,
    version: value.SERVICE_VERSION,
    gitCommit: value.GIT_COMMIT,
  };
}
