import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { bundleWorkflowCode } from "@temporalio/worker";

/** Build step: the pipeline workflows as one deterministic bundle, loaded by the worker at `dist/workflows.cjs`. */
const workflowsPath = fileURLToPath(import.meta.resolve("@crawl-automation/workflows/workflows"));
const { code } = await bundleWorkflowCode({ workflowsPath });
await writeFile(new URL("../dist/workflows.cjs", import.meta.url), code);
