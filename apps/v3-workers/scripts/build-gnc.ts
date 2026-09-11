import { build } from "tsdown";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { bundleWorkflowCode } from "@temporalio/worker";
// Independent build: does not load/copy PDF assets or alter existing role artifacts.
await build({ entry: ["src/gnc-worker.ts", "src/gnc-workflow-worker.ts", "src/gnc-file-grant.ts"], outDir: "dist/gnc", config: false, format: "esm", unbundle: false,
  noExternal: [/^@crawl-automation\/v3-/], external: [/^@temporalio\//, "zod", "pg", "@aws-sdk/client-s3"] });
const bundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL("../src/gnc-workflows.ts", import.meta.url)) });
await writeFile(new URL("../dist/gnc/gnc-workflows.cjs", import.meta.url), bundle.code);
