// Tests of active Crawler V3 code (`pnpm test:v3`); dedicated integration/ suites run separately.
// Some src tests still need permission to start isolated local PostgreSQL or Temporal servers.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/v3-{contracts,vision,artifacts,results,codex,worker-runtime}/src/**/*.test.ts",
      // Only this legacy entry is used by histories predating resource-gate-v1.
      "packages/v3-product/src/resource-workflow.test.ts",
      "apps/{api,worker}/src/**/*.test.ts",
      "packages/{adapters,app,workflows,processing,platform}/src/**/*.test.ts",
      "packages/channels/*/src/**/*.test.ts",
      "ops/deploy/src/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "archive/**",
    ],
    // Evidence storage tests do real hashing and I/O; allow for the whole suite running in parallel.
    testTimeout: 20000,
  },
});
