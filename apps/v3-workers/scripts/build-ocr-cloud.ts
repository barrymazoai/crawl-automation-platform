// Candidate build for the cloud-mode OCR handoff (ledger-less OCR worker + Mini receipt registration).
import {build} from 'tsdown';
import {bundleWorkflowCode} from '@temporalio/worker';
import {writeFile,cp} from 'node:fs/promises';
import {resolve} from 'node:path';
const base='dist/ocr-cloud',common={config:false as const,format:'esm' as const,noExternal:[/^@crawl-automation\/v3-/],external:[/^@temporalio\//,'zod','pg','@aws-sdk/client-s3']};
await build({...common,outDir:base+'/label',entry:['src/channel-label-worker.ts']});
await build({...common,outDir:base+'/model',entry:['src/text-worker.ts','src/vision-worker.ts']});
await build({...common,outDir:base+'/workflow',entry:['src/product-workflow-worker.ts']});
await build({...common,outDir:base+'/tests',external:[...common.external,'vitest'],entry:{
 'results-handoff.test':'../../packages/v3-results/src/handoff.test.ts',
 'review-remote.test':'../../packages/v3-review/src/remote.test.ts',
 'ocr-module.test':'../../packages/v3-ocr/src/module.test.ts',
 'ocr-http.test':'../../packages/v3-ocr/src/http.test.ts',
 'ocr-receipt.test':'../../packages/v3-product/src/ocr-receipt.test.ts',
 'channel-saved-workflow.test':'../../packages/v3-product/src/channel-saved-workflow.test.ts',
 'gnc-stream-workflow.test':'../../packages/v3-product/src/gnc-stream-workflow.test.ts',
 'resource-workflow.test':'../../packages/v3-product/src/resource-workflow.test.ts',
 'brand-workflow.test':'../../packages/v3-product/src/brand-workflow.test.ts',
 'enrichment.test':'../../packages/v3-product/src/enrichment.test.ts',
 'text-cloud.test':'../../packages/v3-text/src/cloud.test.ts',
 'vision-cloud.test':'../../packages/v3-vision/src/cloud.test.ts',
 'amazon-http.test':'../../packages/v3-channels/src/amazon-http.test.ts',
 'amazon-live-config.test':'src/amazon-live-config.test.ts',
 'amazon-live.test':'../../packages/v3-channels/src/amazon-live.test.ts',
 'amazon-link-batches.test':'src/amazon-link-batches.test.ts',
 'amazon-link-store.test':'src/amazon-link-store.test.ts',
 'amazon-queue-temporal.test':'src/amazon-queue-temporal.test.ts',
 'amazon-queue.test':'integration/amazon-queue.test.ts',
 'amazon-queue-live.test':'integration/amazon-queue-live.test.ts',
 'delivery-runner-unit.test':'../v3-api/src/delivery/runner.test.ts',
 'delivery-gateway.test':'../v3-api/src/delivery/temporal-gateway.test.ts',
 'delivery-integration.test':'../v3-api/integration/delivery.test.ts',
 'amazon-catalog-workflow.test':'../../packages/v3-product/src/amazon-catalog-workflow.test.ts',
 'amazon-product-jobs.test':'../../packages/v3-product/src/amazon-product-jobs.test.ts',
 'cache-janitor.test':'src/cache-janitor.test.ts',
 'codex-errors.test':'../../packages/v3-codex/src/errors.test.ts',
 'codex-connection.test':'../../packages/v3-codex/src/connection.test.ts',
 'codex-provider.test':'../../packages/v3-text/src/codex-provider.test.ts',
 'vision-provider/provider.test':'../../packages/v3-vision/src/provider.test.ts',
 'vision-handoff.test':'../../packages/v3-vision/src/handoff.test.ts',
 'quality-review-stops.test':'integration/quality-review-stops.test.ts',
 'resource-stall.test':'integration/resource-stall.test.ts',
 'amazon-batch.test':'integration/amazon-batch.test.ts',
}});
await cp('../../packages/v3-text/src/codex.fixture.mjs',base+'/tests/codex.fixture.mjs');
await cp('../../packages/v3-vision/src/codex.fixture.mjs',base+'/tests/vision-provider/codex.fixture.mjs');
await cp('../../packages/v3-channels/src/fixtures',base+'/tests/fixtures',{recursive:true});
await build({...common,outDir:base+'/batch',entry:['src/amazon-batch-worker.ts']});
await build({...common,outDir:base+'/plan',entry:['src/channel-plan-worker.ts']});
// brand-web reads `migrations/<name>` next to itself and refuses to start when the ledger holds a migration it does not know (020).
await build({...common,outDir:base+'/web',entry:['src/brand-web.ts']});
await build({...common,outDir:base+'/amazon',entry:['src/amazon-live-worker.ts']});
await build({...common,outDir:base+'/queue',entry:['src/amazon-queue-cli.ts']});
await cp('src/amazon-queue-health.mjs',base+'/queue/amazon-queue-health.mjs');
await cp('src/amazon-queue-recovery.mjs',base+'/queue/amazon-queue-recovery.mjs');
for (const dir of ['web','queue','tests']) await cp('../../database/v3',base+'/'+dir+'/migrations',{recursive:true});
// Config schema as a library, so the Mini rollout script can validate the rewritten Amazon private config before binding it.
await build({...common,outDir:base+'/amazon-config',entry:{'amazon-live-config':'src/amazon-live-config.ts','deployment-supervisor':'src/deployment-supervisor.ts','ocr-http':'../../packages/v3-ocr/src/http.ts','capture-probe':'scripts/capture-probe.ts'}});
// The janitor runs on a timer beside the fleet, not inside it: a node whose disk fills up stops the whole line.
await build({...common,outDir:base+'/janitor',entry:{'cache-janitor':'src/cache-janitor.ts'}});
{const bundle=await bundleWorkflowCode({workflowsPath:resolve('src/amazon-batch-workflow.ts')});await writeFile(base+'/batch/amazon-batch-workflows.cjs',bundle.code);await writeFile(base+'/tests/amazon-batch-workflows.cjs',bundle.code);}
for(const [entry,file] of [['src/product-workflows.ts','workflow/product-workflows.cjs'],['integration/resource-stall-workflows.ts','tests/resource-stall-workflows.cjs'],['integration/amazon-queue-workflows.ts','tests/amazon-queue-workflows.cjs']]){
 const bundle=await bundleWorkflowCode({workflowsPath:resolve(entry!)});await writeFile(base+'/'+file,bundle.code);
}
console.log('built',base);
