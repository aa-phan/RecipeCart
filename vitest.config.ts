import "dotenv/config";
import { defineConfig } from "vitest/config";

// The suite now runs against a real Postgres (Phase 3). Migrations run once via
// globalSetup; DB tests truncate between cases. File parallelism is disabled so
// the shared test DB is never mutated by two files at once — single-user
// project, correctness over test speed.
export default defineConfig({
  test: {
    // `npm run build` compiles *.test.ts into dist/*.test.js — exclude dist so
    // the suite doesn't double-run every test (compiled + source).
    exclude: ["**/node_modules/**", "**/dist/**"],
    globalSetup: ["./src/platform/test-setup.ts"],
    fileParallelism: false,
    env: {
      // Route app code (config → getDb) at the test DB. Overridden by a real
      // TEST_DATABASE_URL from .env if set (test-setup also enforces presence).
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
      // Fixed, known value so setup.test.ts doesn't depend on the developer's
      // local .env having a real SETUP_SECRET set (src/api/routes/setup.ts).
      SETUP_SECRET: "test-setup-secret",
    },
  },
});
