import {build} from 'tsdown';
import {bundleWorkflowCode} from '@temporalio/worker';
import {writeFile,copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const base='dist/resource-finally',common={config:false as const,format:'esm' as const,noExternal:[/^@crawl-automation\/v3-/],external:[/^@temporalio\//,'zod','pg','@aws-sdk/client-s3']};
await build({...common,outDir:base+'/label',entry:['src/channel-label-worker.ts']});
await build({...common,outDir:base+'/workflow',entry:['src/product-workflow-worker.ts']});
await build({...common,outDir:base+'/tests',external:[...common.external,'vitest'],entry:{
 'resource-workflow.test':'../../packages/v3-product/src/resource-workflow.test.ts',
 'quality-review-stops.test':'integration/quality-review-stops.test.ts',
 'ocr-http.test':'../../packages/v3-ocr/src/http.test.ts',
 'channel-label-execution.test':'src/channel-label-execution.test.ts',
 'channel-saved-workflow.test':'../../packages/v3-product/src/channel-saved-workflow.test.ts',
 'gnc-stream-workflow.test':'../../packages/v3-product/src/gnc-stream-workflow.test.ts',
 'text/text-provider.test':'../../packages/v3-text/src/codex-provider.test.ts',
 'vision/vision-provider.test':'../../packages/v3-vision/src/provider.test.ts',
 'codex-close.test':'../../packages/v3-codex/src/close.test.ts',
 'resource-stall.test':'integration/resource-stall.test.ts',
}});
for(const [entry,file] of [['src/product-workflows.ts','workflow/product-workflows.cjs'],['integration/resource-stall-workflows.ts','tests/resource-stall-workflows.cjs']]){
 const bundle=await bundleWorkflowCode({workflowsPath:resolve(entry!)});await writeFile(base+'/'+file,bundle.code);
}

await copyFile('../../packages/v3-text/src/codex.fixture.mjs',base+'/tests/text/codex.fixture.mjs');
await copyFile('../../packages/v3-vision/src/codex.fixture.mjs',base+'/tests/vision/codex.fixture.mjs');
