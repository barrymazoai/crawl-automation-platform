import{build}from'tsdown';import{bundleWorkflowCode}from'@temporalio/worker';import{writeFile,cp}from'node:fs/promises';import{resolve}from'node:path';
const common={config:false as const,format:'esm' as const,noExternal:[/^@crawl-automation\/v3-/],external:[/^@temporalio\//,'zod','pg','vitest','@aws-sdk/client-s3']};
await build({...common,entry:Object.fromEntries(['amazon-live-worker','channel-label-worker','channel-plan-worker','product-workflow-worker','brand-web'].map(n=>[n,`src/${n}.ts`])),outDir:'dist/amazon-mainflow'});
await writeFile('dist/amazon-mainflow/product-workflows.cjs',(await bundleWorkflowCode({workflowsPath:resolve('src/product-workflows.ts')})).code);
await build({...common,entry:{'amazon-ego.test':'../../packages/v3-channels/src/amazon-ego.test.ts','amazon-catalog-workflow.test':'../../packages/v3-product/src/amazon-catalog-workflow.test.ts','amazon-live.test':'../../packages/v3-channels/src/amazon-live.test.ts','amazon.test':'../../packages/v3-channels/src/amazon.test.ts','swanson-live.test':'../../packages/v3-channels/src/swanson-live.test.ts','catalog-workflow.test':'../../packages/v3-product/src/catalog-workflow.test.ts','channel-stream.test':'integration/channel-stream.test.ts','ego-task-pages.test':'../../packages/v3-acquisition/src/ego-task-pages.test.ts'},outDir:'dist/amazon-mainflow-tests'});

await build({...common,entry:{'prepare-amazon-brand':'scripts/prepare-amazon-brand.ts'},outDir:'dist/amazon-prepare'});
await cp('../../database/v3','dist/amazon-mainflow/migrations',{recursive:true});
await build({...common,entry:{'mini-amazon-inspect':'scripts/mini-amazon-inspect.ts'},outDir:'dist/amazon-inspect'});
