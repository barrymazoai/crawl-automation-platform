// Unit tests of every Crawler V3 package and app (`pnpm test:v3`). Integration tests that need a live
// Postgres, Temporal or saved fixtures on Server 一 live in `integration/` folders and run separately.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/v3-*/src/**/*.test.ts",
      "apps/v3-api/src/**/*.test.ts",
      "apps/v3-workers/src/**/*.test.ts",
      "apps/{api,worker,cli}/src/**/*.test.ts",
      "packages/{app,workflows,processing,platform}/src/**/*.test.ts",
      "packages/channels/*/src/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Some archive tests do real hashing and I/O; 5 s is too short when the whole suite runs in parallel.
    testTimeout: 20000,
  },
});
