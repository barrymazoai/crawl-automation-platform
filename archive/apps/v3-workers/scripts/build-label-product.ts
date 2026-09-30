import { build } from "tsdown";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { bundleWorkflowCode } from "@temporalio/worker";
// Build existing generic entries into a distinct directory, without PDF asset installation.
await build({ entry: ["src/product-worker.ts", "src/product-workflow-worker.ts"], outDir: "dist/label", config: false,
  format: "esm", noExternal: [/^@crawl-automation\/v3-/], external: [/^@temporalio\//, "zod", "pg", "@aws-sdk/client-s3"] });
const bundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL("../src/product-workflows.ts", import.meta.url)) });
await writeFile(new URL("../dist/label/product-workflows.cjs", import.meta.url), bundle.code);
