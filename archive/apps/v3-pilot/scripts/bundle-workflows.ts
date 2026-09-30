import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { bundleWorkflowCode } from "@temporalio/worker";

const bundle = await bundleWorkflowCode({
  workflowsPath: fileURLToPath(
    new URL("../src/workflows/index.ts", import.meta.url),
  ),
});
await mkdir(new URL("../dist", import.meta.url), { recursive: true });
await writeFile(
  new URL("../dist/workflow-bundle.cjs", import.meta.url),
  bundle.code,
);
