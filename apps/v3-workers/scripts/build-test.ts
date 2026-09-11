import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import { bundleWorkflowCode } from "@temporalio/worker";

// Explicit test build: ordinary pnpm build never includes the fixture entry or Workflow.
await build({ entry: ["integration/fixtures/worker.ts"], outDir: ".local/test-dist", format: "esm", config: false,
  noExternal: ["@crawl-automation/v3-worker-runtime"], external: [/^@temporalio\//, "zod"] });
const bundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL("../integration/fixtures/workflows.ts", import.meta.url)) });
await writeFile(new URL("../.local/test-dist/workflows.cjs", import.meta.url), bundle.code);
const ocrBundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL("../integration/fixtures/ocr-workflows.ts", import.meta.url)) });
await writeFile(new URL("../.local/test-dist/ocr-workflows.cjs", import.meta.url), ocrBundle.code);
const textBundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL("../integration/fixtures/text-workflows.ts", import.meta.url)) });
await writeFile(new URL("../.local/test-dist/text-workflows.cjs", import.meta.url), textBundle.code);
const visionBundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL("../integration/fixtures/vision-workflows.ts", import.meta.url)) });
await writeFile(new URL("../.local/test-dist/vision-workflows.cjs", import.meta.url), visionBundle.code);
