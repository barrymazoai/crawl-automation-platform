import { build } from "tsdown";
await build({ entry: {
  "label-packaging.test": "../../packages/v3-product/src/label-packaging.test.ts",
  "label-product.test": "../../packages/v3-product/src/label-product.test.ts",
  "label-core.test": "../../packages/v3-acquisition/src/label-core.test.ts",
  "gnc-stream-workflow.test": "../../packages/v3-product/src/gnc-stream-workflow.test.ts",
  "text-evidence.test": "../../packages/v3-text/src/evidence.test.ts",
  "text-label-execution.test": "../../packages/v3-text/src/label-execution.test.ts",
  "text-label-extraction.test": "../../packages/v3-text/src/label-extraction.test.ts",
}, outDir: "dist/packaging-tests", config: false, format: "esm", noExternal: [/^@crawl-automation\/v3-/],
external: ["vitest", "zod", /^@temporalio\//, "@aws-sdk/client-s3", "pg"] });
