// Mini-only offline replay: executes no Activities and submits no tasks.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {hostname} from 'node:os';
import {gunzipSync} from 'node:zlib';
import {Worker} from '@temporalio/worker';
import temporalProto from '@temporalio/proto';
const [work]=process.argv.slice(2),base='/Users/barry/apps/crawlv3-history-20260913';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),results=[];
async function replay(history,id){
 const decoded=temporalProto.temporal.api.history.v1.History.fromObject(history);
 await Worker.runReplayHistory({workflowBundle:{codePath:work+'/candidate/workflow/product-workflows.cjs'}},decoded,id);
 results.push({workflowId:id,eventCount:history.events.length,passed:true});
}
for(const dir of ['amazon-throughput-20260914','amazon-unified-retest-10-20260914']){
 const {out}=await read(base+'/'+dir+'/acceptance-10.json'),timing=await read(out+'/timing.json');
 for(const w of timing.workflows)await replay(await read(out+'/history-'+w.runId+'.json'),w.id);
}
const audit=await read(base+'/amazon-resource-stall-fix-20260914/recovery-audit.json');
for(const which of ['parent','child']){
 const bytes=await fs.readFile(base+'/amazon-resource-recovery-20260914/'+audit.parentRunId+'.'+which+'-history.json.gz');
 await replay(JSON.parse(gunzipSync(bytes).toString()),audit.workflowId+(which==='child'?'-label':''));
}
await fs.writeFile(work+'/replay-results.json',JSON.stringify({passed:true,activityCalls:0,results},null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({passed:true,histories:results.length,activityCalls:0}));
