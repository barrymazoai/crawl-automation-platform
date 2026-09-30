import {build} from 'tsdown';
const base='dist/stop-local',common={config:false as const,format:'esm' as const,noExternal:[/^@crawl-automation\/v3-/],external:[/^@temporalio\//,'zod','pg','@aws-sdk/client-s3']};
await build({...common,outDir:base+'/label',entry:['src/channel-label-worker.ts']});
await build({...common,outDir:base+'/lib',entry:{'quality-review-stops':'src/quality-review-stops.ts','stop-tools':'scripts/stop-local-tools.ts'}});
await build({...common,outDir:base+'/tests',external:[...common.external,'vitest'],entry:{
 'quality-review-stops.test':'integration/quality-review-stops.test.ts',
 'resource-workflow.test':'../../packages/v3-product/src/resource-workflow.test.ts',
 'channel-label-execution.test':'src/channel-label-execution.test.ts',
}});
