import { build } from "tsdown";
import { bundleWorkflowCode } from "@temporalio/worker";
import { writeFile, cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const common={config:false as const,format:"esm" as const,noExternal:[/^@crawl-automation\/v3-/],external:[/^@temporalio\//,"zod","pg","vitest","@aws-sdk/client-s3"]};
await build({...common,entry:Object.fromEntries(["swanson-live-worker","channel-label-worker","channel-plan-worker","brand-web","product-workflow-worker","live-gnc-worker","brand-pipeline-worker","deployment-supervisor"].map(n=>[n,`src/${n}.ts`])),outDir:"dist/channel-resident"});
const bundle=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL("../src/product-workflows.ts",import.meta.url))});
await writeFile(new URL("../dist/channel-resident/product-workflows.cjs",import.meta.url),bundle.code);
await cp(new URL("../../../database/v3/",import.meta.url),new URL("../dist/channel-resident/migrations/",import.meta.url),{recursive:true});
await build({...common,entry:{
 "swanson-live.test":"../../packages/v3-channels/src/swanson-live.test.ts",
 "swanson-catalog-rendered.test":"../../packages/v3-channels/src/swanson-catalog-rendered.test.ts",
 "swanson-catalog-workflow.test":"../../packages/v3-product/src/swanson-catalog-workflow.test.ts",
 "catalog-workflow.test":"../../packages/v3-product/src/catalog-workflow.test.ts",
 "gnc-leased-workflow.test":"../../packages/v3-product/src/gnc-leased-workflow.test.ts",
 "brand-pipeline.test":"src/brand-pipeline.test.ts",
 "ego-task-pages.test":"../../packages/v3-acquisition/src/ego-task-pages.test.ts",
},outDir:"dist/channel-resident-tests"});
