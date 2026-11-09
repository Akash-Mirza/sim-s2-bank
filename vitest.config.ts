import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Generous enough for a remote (Neon/cloud) database: each query is a network
    // round-trip, so a database-heavy test can take seconds instead of milliseconds.
    // The local Docker database finishes in milliseconds, so this never slows it down.
    testTimeout: 60000,
    hookTimeout: 30000,
    restoreMocks: true,
    // Integration files share one Postgres database; run files one at a time.
    fileParallelism: false,
  },
});
