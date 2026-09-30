import { build } from "tsdown";
import { bundleWorkflowCode } from "@temporalio/worker";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
await build({ entry: ["scripts/mini-channel-plan-smoke.ts"], outDir: "dist/channel-plan-smoke", config: false, format: "esm",
  noExternal: [/^@crawl-automation\/v3-/], external: [/^@temporalio\//, "zod", "pg", "@aws-sdk/client-s3"] });
const bundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL("../integration/channel-plan-proof-workflows.ts", import.meta.url)) });
await writeFile(new URL("../dist/channel-plan-smoke/channel-plan-proof.cjs", import.meta.url), bundle.code);
