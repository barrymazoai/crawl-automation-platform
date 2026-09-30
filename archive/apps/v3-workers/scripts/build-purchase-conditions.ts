import {build} from 'tsdown';
import {cp} from 'node:fs/promises';
const base='dist/purchase-conditions',common={config:false as const,format:'esm' as const,noExternal:[/^@crawl-automation\/v3-/],external:[/^@temporalio\//,'zod','pg','@aws-sdk/client-s3']};
// Keep existing workflow executables. Only these isolated Activity roles change.
for(const [group,entry] of Object.entries({amazon:'src/amazon-live-worker.ts',plan:'src/channel-plan-worker.ts',label:'src/channel-label-worker.ts',batch:'src/amazon-batch-worker.ts',export:'../v3-api/src/history-cli.ts',acceptance:'scripts/purchase-conditions-inspect.ts'}))
 await build({...common,outDir:base+'/'+group,entry:[entry]});
await cp('../../database/v3',base+'/migrations',{recursive:true});
await build({...common,outDir:base+'/tests',external:[...common.external,'vitest'],noExternal:[...common.noExternal,/^linkedom$/,/^htmlparser2$/,/^css-select$/,/^cssom$/,/^uhyphen$/,/^domhandler$/,/^domutils$/,/^domelementtype$/,/^entities$/,/^boolbase$/,/^css-what$/,/^nth-check$/,/^dom-serializer$/],entry:{
 'commerce-metrics.test':'src/commerce-metrics.test.ts',
 'amazon-ego.test':'../../packages/v3-channels/src/amazon-ego.test.ts',
 'vision-label.test':'../../packages/v3-vision/src/label-extraction.test.ts',
 'label-product.test':'../../packages/v3-product/src/label-product.test.ts',
 'label-image-first.test':'../../packages/v3-product/src/label-image-first.test.ts',
 'purchase-conditions.test':'../../packages/v3-channels/src/purchase-conditions.test.ts',
 'commerce-dom.test':'../../packages/v3-channels/src/commerce-dom.test.ts',
 'amazon-live.test':'../../packages/v3-channels/src/amazon-live.test.ts',
 'channel-plan.test':'../../packages/v3-channels/src/channel-plan.test.ts',
 'artifact-read-scope.test':'../../packages/v3-artifacts/src/read-scope.test.ts',
 'amazon-link-batches.test':'src/amazon-link-batches.test.ts',
 'channel-label-execution.test':'src/channel-label-execution.test.ts',
 'channel-saved-workflow.test':'../../packages/v3-product/src/channel-saved-workflow.test.ts',
 'price-conditions.test':'src/price-conditions.test.ts',
 'purchase-data-flow.test':'src/purchase-data-flow.test.ts',
 'amazon-batch-control.test':'src/amazon-batch-control.test.ts',
 'history-model.test':'../v3-api/src/history/model.test.ts',
 'product-service.test':'../v3-api/src/history/product-service.test.ts',
 'history-observations.test':'integration/history-observations.test.ts',
}});
