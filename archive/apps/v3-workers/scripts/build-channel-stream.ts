import{build}from"tsdown";import{bundleWorkflowCode}from"@temporalio/worker";import{writeFile,cp}from"node:fs/promises";import{resolve}from"node:path";
const common={config:false as const,format:"esm" as const,noExternal:[/^@crawl-automation\/v3-/],external:[/^@temporalio\//,"zod","pg","vitest","@aws-sdk/client-s3"]};
await build({...common,entry:{"swanson-live-worker":"src/swanson-live-worker.ts","product-workflow-worker":"src/product-workflow-worker.ts"},outDir:"dist/channel-stream"});
const bundle=(await bundleWorkflowCode({workflowsPath:resolve("src/product-workflows.ts")})).code;await writeFile("dist/channel-stream/product-workflows.cjs",bundle);
await build({...common,entry:{"channel-saved-workflow.test":"../../packages/v3-product/src/channel-saved-workflow.test.ts","swanson-catalog-workflow.test":"../../packages/v3-product/src/swanson-catalog-workflow.test.ts","resource-workflow.test":"../../packages/v3-product/src/resource-workflow.test.ts","channel-stream.test":"integration/channel-stream.test.ts"},outDir:"dist/channel-stream-tests"});
await cp("dist/channel-stream/product-workflows.cjs","dist/channel-stream-tests/product-workflows.cjs");
