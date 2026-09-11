import { build } from "tsdown";
import { writeFile, cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { bundleWorkflowCode } from "@temporalio/worker";
await build({entry:{"gnc-worker":"src/gnc-worker.ts","gnc-workflow-worker":"src/gnc-workflow-worker.ts","mini-ego-capture":"scripts/mini-ego-capture.ts"},outDir:"dist/ego-capture",config:false,format:"esm",
  noExternal:[/^@crawl-automation\/v3-/],external:[/^@temporalio\//,"zod","pg","@aws-sdk/client-s3"]});
const bundle=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL("../src/gnc-workflows.ts",import.meta.url))});
await writeFile(new URL("../dist/ego-capture/gnc-workflows.cjs",import.meta.url),bundle.code);
await cp(new URL("../../../database/v3/",import.meta.url),new URL("../dist/ego-capture/migrations/",import.meta.url),{recursive:true});
