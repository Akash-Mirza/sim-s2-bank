import { loadDotenv } from "./config/dotenv.js";
import { loadEnv } from "./config/env.js";
import { buildServer } from "./http/server.js";

async function main(): Promise<void> {
  loadDotenv();
  const env = loadEnv();
  const app = buildServer(env);

  await app.listen({ port: env.port, host: env.host });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  console.error(
    JSON.stringify({ level: "fatal", msg: "server failed to start", error: `${error}` }),
  );
  process.exit(1);
});
