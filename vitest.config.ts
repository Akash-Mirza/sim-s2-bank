import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 30000,
    restoreMocks: true,
    // Integration files share one Postgres database; run files one at a time.
    fileParallelism: false,
  },
});
