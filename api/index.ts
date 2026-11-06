import type { IncomingMessage, ServerResponse } from "node:http";
import { loadDotenv } from "../src/config/dotenv.js";
import { loadEnv } from "../src/config/env.js";
import { buildServer } from "../src/http/server.js";

// Vercel Node function: one cached Fastify instance per lambda container.
const appPromise = (async () => {
  loadDotenv();
  const app = buildServer(loadEnv());
  await app.ready();
  return app;
})();

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const app = await appPromise;
  app.server.emit("request", req, res);
}
