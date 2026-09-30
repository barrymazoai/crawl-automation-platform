import { build } from "tsdown";
// Build locally; execute only on Mac mini. Tests inject provider responses, with no paid requests.
await build({ config: false, format: "esm", noExternal: [/^@crawl-automation\/v3-/], external: ["zod", "vitest", /^@temporalio\//],
  entry: {
    "scraperapi.test": "../../packages/v3-acquisition/src/scraperapi.test.ts",
    "routes.test": "../../packages/v3-acquisition/src/routes.test.ts",
    "label-core.test": "../../packages/v3-acquisition/src/label-core.test.ts",
    "amazon.test": "../../packages/v3-channels/src/amazon.test.ts",
    "swanson.test": "../../packages/v3-channels/src/swanson.test.ts",
    "channel-plan.test": "../../packages/v3-channels/src/channel-plan.test.ts",
    "channel-brand.test": "../../packages/v3-channels/src/channel-brand.test.ts",
    "ego-task-pages.test": "../../packages/v3-acquisition/src/ego-task-pages.test.ts",
    "gnc-leased-workflow.test": "../../packages/v3-product/src/gnc-leased-workflow.test.ts",
    "brand-pipeline.test": "src/brand-pipeline.test.ts",
    "channel-saved-workflow.test": "../../packages/v3-product/src/channel-saved-workflow.test.ts",
    "swanson-catalog-rendered.test": "../../packages/v3-channels/src/swanson-catalog-rendered.test.ts",
  }, outDir: "dist/channel-batch-tests" });
