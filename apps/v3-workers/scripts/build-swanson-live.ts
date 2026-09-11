import { build } from "tsdown";
import { bundleWorkflowCode } from "@temporalio/worker";
import { writeFile,cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const common = { config: false as const, format: "esm" as const, noExternal: [/^@crawl-automation\/v3-/], external: [/^@temporalio\//, "zod", "pg", "vitest", "@aws-sdk/client-s3"] };
await build({ ...common, entry: { "swanson-live-worker": "src/swanson-live-worker.ts", "channel-label-worker":"src/channel-label-worker.ts", "channel-plan-worker":"src/channel-plan-worker.ts", "brand-web":"src/brand-web.ts", "product-workflow-worker": "src/product-workflow-worker.ts", "mini-swanson-replay": "scripts/mini-swanson-replay.ts", "mini-channel-worker-preflight":"scripts/mini-channel-worker-preflight.ts", "prepare-swanson-brand":"scripts/prepare-swanson-brand.ts" }, outDir: "dist/swanson-live" });
await build({ ...common, entry: {
  "swanson-live.test": "../../packages/v3-channels/src/swanson-live.test.ts",
  "swanson-catalog-workflow.test": "../../packages/v3-product/src/swanson-catalog-workflow.test.ts",
  "catalog-workflow.test": "../../packages/v3-product/src/catalog-workflow.test.ts",
  "brand-workflow.test": "../../packages/v3-product/src/brand-workflow.test.ts",
  "quality-review-stops.test":"integration/quality-review-stops.test.ts",
  "channel-label-execution.test":"src/channel-label-execution.test.ts",
  "routed-coordinator.test":"../v3-api/src/delivery/routed-coordinator.test.ts",
  "delivery-config.test":"../v3-api/src/bootstrap/delivery-config.test.ts",
}, outDir: "dist/swanson-live-tests" });
const bundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL("../src/product-workflows.ts", import.meta.url)) });
await writeFile(new URL("../dist/swanson-live/product-workflows.cjs", import.meta.url), bundle.code);
await cp(new URL("../../../database/v3/",import.meta.url),new URL("../dist/swanson-live/migrations/",import.meta.url),{recursive:true});
