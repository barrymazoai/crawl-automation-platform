import { build } from "tsdown";
await build({ entry: {
  "gnc.test": "../../packages/v3-channels/src/gnc.test.ts",
  "gnc-product.test": "../../packages/v3-channels/src/gnc-product.test.ts",
  "gnc-stream-workflow.test": "../../packages/v3-product/src/gnc-stream-workflow.test.ts",
  "label-packaging.test": "../../packages/v3-product/src/label-packaging.test.ts",
  "label-image-first.test": "../../packages/v3-product/src/label-image-first.test.ts",
  "label-product.test": "../../packages/v3-product/src/label-product.test.ts",
  "label-text-product.test": "../../packages/v3-product/src/label-text-product.test.ts",
  "label-core.test": "../../packages/v3-acquisition/src/label-core.test.ts",
  "artifact-resolver.test": "../../packages/v3-artifacts/src/resolver.test.ts",
  "result-handoff.test": "../../packages/v3-results/src/handoff.test.ts",
  "keywords.test": "../../packages/v3-vision/src/keywords.test.ts",
  "quality-sample.test": "scripts/quality/gnc-sample.test.ts",
}, outDir: "dist/batch-one-tests", config: false, format: "esm", noExternal: [/^@crawl-automation\/v3-/],
external: ["vitest", "zod", /^@temporalio\//, "@aws-sdk/client-s3", "pg"] });
