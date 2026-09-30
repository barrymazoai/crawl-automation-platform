import {build} from 'tsdown';
import {bundleWorkflowCode} from '@temporalio/worker';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const base='dist/detached-files',common={config:false as const,format:'esm' as const,noExternal:[/^@crawl-automation\/v3-/],external:[/^@temporalio\//,'zod','pg','@aws-sdk/client-s3']};
for(const [group,entry]of Object.entries({amazon:'src/amazon-live-worker.ts',workflow:'src/product-workflow-worker.ts',acceptance:'scripts/purchase-conditions-inspect.ts'}))await build({...common,outDir:base+'/'+group,entry:[entry]});
await build({...common,outDir:base+'/tests',external:[...common.external,'vitest'],noExternal:[...common.noExternal,/^linkedom$/,/^htmlparser2$/,/^css-select$/,/^cssom$/,/^uhyphen$/,/^domhandler$/,/^domutils$/,/^domelementtype$/,/^entities$/,/^boolbase$/,/^css-what$/,/^nth-check$/,/^dom-serializer$/],entry:{
 'amazon-staged-files.test':'src/amazon-staged-files.test.ts',
 'amazon-catalog-workflow.test':'../../packages/v3-product/src/amazon-catalog-workflow.test.ts',
 'ego-task-pages.test':'../../packages/v3-acquisition/src/ego-task-pages.test.ts',
 'amazon-live.test':'../../packages/v3-channels/src/amazon-live.test.ts',
 'channel-saved-workflow.test':'../../packages/v3-product/src/channel-saved-workflow.test.ts',
 'resource-workflow.test':'../../packages/v3-product/src/resource-workflow.test.ts',
 'handoff.test':'../../packages/v3-acquisition/src/handoff.test.ts',
 'artifact-read-scope.test':'../../packages/v3-artifacts/src/read-scope.test.ts',
 'channel-label-execution.test':'src/channel-label-execution.test.ts',
}});
const bundle=await bundleWorkflowCode({workflowsPath:resolve('src/product-workflows.ts')});await writeFile(base+'/workflow/product-workflows.cjs',bundle.code);
