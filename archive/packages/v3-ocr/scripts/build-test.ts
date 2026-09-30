import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import { bundleWorkflowCode } from "@temporalio/worker";
await build({ entry: ["integration/fixtures/worker.ts"], outDir: ".local/test-dist", format: "esm", config: false,
  noExternal: [/^@crawl-automation\/v3-/], external: [/^@temporalio\//, "pg", "zod"] });
const bundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL("../integration/fixtures/workflows.ts", import.meta.url)) });
await writeFile(new URL("../.local/test-dist/workflows.cjs", import.meta.url), bundle.code);
