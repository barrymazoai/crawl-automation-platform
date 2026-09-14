import {build} from 'tsdown';
import {bundleWorkflowCode} from '@temporalio/worker';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const base='dist/resource-stall',common={config:false as const,format:'esm' as const,noExternal:[/^@crawl-automation\/v3-/],external:[/^@temporalio\//,'zod','pg','@aws-sdk/client-s3']};
await build({...common,outDir:base+'/label',entry:['src/channel-label-worker.ts']});
await build({...common,outDir:base+'/workflow',entry:['src/product-workflow-worker.ts']});
await build({...common,outDir:base+'/amazon',entry:['src/amazon-live-worker.ts']});
await build({...common,outDir:base+'/recovery',entry:['scripts/recover-amazon-label-stop.ts']});
await build({...common,outDir:base+'/tests',external:[...common.external,'vitest'],entry:{
 'resource-workflow.test':'../../packages/v3-product/src/resource-workflow.test.ts',
 'quality-review-stops.test':'integration/quality-review-stops.test.ts',
 'channel-label-execution.test':'src/channel-label-execution.test.ts',
 'channel-saved-workflow.test':'../../packages/v3-product/src/channel-saved-workflow.test.ts',
 'stopped-model-recovery.test':'src/stopped-model-recovery.test.ts',
 'amazon-batch-control.test':'src/amazon-batch-control.test.ts',
 'amazon-label-terminal-proof.test':'src/amazon-label-terminal-proof.test.ts',
 'r2.test':'../../packages/v3-artifacts/src/r2.test.ts',
 'resource-stall.test':'integration/resource-stall.test.ts',
 'amazon-batch.test':'integration/amazon-batch.test.ts',
}});
for(const [entry,file] of [['src/product-workflows.ts','workflow/product-workflows.cjs'],['integration/resource-stall-workflows.ts','tests/resource-stall-workflows.cjs'],['src/amazon-batch-workflow.ts','tests/amazon-batch-workflows.cjs']]){
 const bundle=await bundleWorkflowCode({workflowsPath:resolve(entry!)});await writeFile(base+'/'+file,bundle.code);
}
