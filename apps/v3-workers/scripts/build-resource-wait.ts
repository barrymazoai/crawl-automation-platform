import {build} from "tsdown";
import {bundleWorkflowCode} from "@temporalio/worker";
import {writeFile,mkdir} from "node:fs/promises";
import {resolve} from "node:path";
const common={config:false as const,format:"esm" as const,noExternal:[/^@crawl-automation\/v3-/],external:[/^@temporalio\//,"zod","pg","vitest","@aws-sdk/client-s3"]};
await build({...common,entry:{"resource-wait.test":"integration/resource-wait.test.ts","resource-workflow.test":"../../packages/v3-product/src/resource-workflow.test.ts","channel-saved-workflow.test":"../../packages/v3-product/src/channel-saved-workflow.test.ts"},outDir:"dist/resource-wait-tests"});
await writeFile("dist/resource-wait-tests/resource-wait-workflows.cjs",(await bundleWorkflowCode({workflowsPath:resolve("integration/resource-wait-workflows.ts")})).code);
await mkdir("dist/resource-wait-workflows",{recursive:true});
await writeFile("dist/resource-wait-workflows/product-workflows.cjs",(await bundleWorkflowCode({workflowsPath:resolve("src/product-workflows.ts")})).code);
