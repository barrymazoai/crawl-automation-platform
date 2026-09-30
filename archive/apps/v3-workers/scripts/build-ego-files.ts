import {build} from "tsdown";
import {writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {bundleWorkflowCode} from "@temporalio/worker";
await build({entry:{"gnc-worker":"src/gnc-worker.ts","mini-ego-files":"scripts/mini-ego-files.ts"},outDir:"dist/ego-files",config:false,format:"esm",
  noExternal:[/^@crawl-automation\/v3-/],external:[/^@temporalio\//,"zod","pg","@aws-sdk/client-s3"]});
const bundle=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL("./ego-file-acceptance-workflow.ts",import.meta.url))});
await writeFile(new URL("../dist/ego-files/ego-file-acceptance.cjs",import.meta.url),bundle.code);
