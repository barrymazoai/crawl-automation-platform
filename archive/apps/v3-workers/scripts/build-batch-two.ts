import { build } from "tsdown";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { bundleWorkflowCode } from "@temporalio/worker";
import { migrationNames } from "../../v3-api/src/bootstrap/schema.js";
await build({ entry: { "mini-batch-two": "scripts/mini-batch-two.ts", "catalog-worker": "src/catalog-worker.ts", "product-workflow-worker": "src/product-workflow-worker.ts", "dashboard-preview": "../v3-api/src/dashboard-preview.ts" },
  outDir: "dist/batch-two", config: false, format: "esm", noExternal: [/^@crawl-automation\/v3-/], external: [/^@temporalio\//, "zod", "pg", "@aws-sdk/client-s3"] });
await build({ entry: { "catalog-workflow.test": "../../packages/v3-product/src/catalog-workflow.test.ts", "catalog-product.test": "../../packages/v3-product/src/catalog-product.test.ts", "gnc-catalog-source.test": "../../packages/v3-channels/src/gnc-catalog-source.test.ts", "catalog-config.test": "src/catalog-config.test.ts" }, outDir: "dist/batch-two-tests", config: false,
  format: "esm", noExternal: [/^@crawl-automation\/v3-/], external: ["vitest", /^@temporalio\//, "zod", "pg", "@aws-sdk/client-s3"] });
for (const [source, target] of [["../integration/catalog-proof-workflows.ts", "catalog-proof-workflows.cjs"], ["../src/product-workflows.ts", "product-workflows.cjs"]]) {
  const bundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL(source!, import.meta.url)) });
  await writeFile(new URL(`../dist/batch-two/${target}`, import.meta.url), bundle.code);
}
await mkdir(new URL("../dist/batch-two/migrations/", import.meta.url), { recursive: true });
for (const name of migrationNames) await copyFile(new URL(`../../../database/v3/${name}`,import.meta.url),new URL(`../dist/batch-two/migrations/${name}`,import.meta.url));
