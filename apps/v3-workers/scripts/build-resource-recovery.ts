import { build } from "tsdown";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { bundleWorkflowCode } from "@temporalio/worker";
import { resolve } from "node:path";
import { migrationNames } from "../../v3-api/src/bootstrap/schema.js";
const common = { config: false as const, format: "esm" as const, noExternal: [/^@crawl-automation\/v3-/], external: [/^@temporalio\//, "zod", "pg", "@aws-sdk/client-s3", "vitest"] };
await build({ ...common, entry: { "resource-recovery": "scripts/resource-recovery.ts", "verify-resource-deployment": "scripts/verify-resource-deployment.ts" }, outDir: "dist/resource-recovery" });
await build({ ...common, entry: {
  "resource-recovery.test": "../../packages/v3-product/src/resource-recovery.test.ts",
  "temporal-resource-evidence.test": "src/temporal-resource-evidence.test.ts",
  "resource-recovery-integration.test": "integration/resource-recovery.test.ts",
  "resource-workflow.test": "../../packages/v3-product/src/resource-workflow.test.ts",
  "ocr-handoff.test": "../../packages/v3-results/src/handoff.test.ts",
  "vision-handoff.test": "../../packages/v3-vision/src/handoff.test.ts",
}, outDir: "dist/resource-recovery-tests" });
const bundle = await bundleWorkflowCode({ workflowsPath: resolve("integration/resource-recovery-workflows.ts") });
await writeFile("dist/resource-recovery-tests/recovery-workflows.cjs", bundle.code);
await mkdir("dist/resource-recovery-tests/migrations", { recursive: true });
for (const name of migrationNames) await copyFile(resolve(`../../database/v3/${name}`), resolve(`dist/resource-recovery-tests/migrations/${name}`));
