// Mini-only offline replay: no Activity execution or business submission.
import fs from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {hostname} from 'node:os';
import {Worker} from '@temporalio/worker';
import temporalProto from '@temporalio/proto';
const base='/Users/barry/apps/crawlv3-history-20260913',dir=base+'/amazon-resource-stall-fix-20260914',root=base+'/amazon-resource-recovery-20260914';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const audit=JSON.parse(await fs.readFile(dir+'/recovery-audit.json','utf8'));assert.equal(audit.status,'recoverable');
await fs.mkdir(root+'/histories',{recursive:true,mode:0o700});
const results=[];
for(const which of ['parent','child']){
 const content=await fs.readFile(root+'/'+audit.parentRunId+'.'+which+'-history.json.gz'),history=JSON.parse(gunzipSync(content).toString());
 const input=history.events[0].workflowExecutionStartedEventAttributes;
 const workflowId=which==='parent'?audit.workflowId:audit.workflowId+'-label',runId=which==='parent'?audit.parentRunId:input.originalExecutionRunId;
 assert.match(runId,/^[a-f0-9-]{36}$/);assert.ok(history.events.at(-1).workflowExecutionFailedEventAttributes||history.events.at(-1).workflowExecutionTerminatedEventAttributes);
 const decoded=temporalProto.temporal.api.history.v1.History.fromObject(history);
 await Worker.runReplayHistory({workflowBundle:{codePath:dir+'/resource-stall/workflow/product-workflows.cjs'}},decoded,workflowId);
 const sha256=createHash('sha256').update(content).digest('hex'),cache=root+'/histories/'+runId;
 for(const [path,bytes] of [[cache+'.json.gz',content],[cache+'.json',Buffer.from(JSON.stringify({workflowId,runId,sha256}))]]){
  try{await fs.writeFile(path,bytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;assert.deepEqual(await fs.readFile(path),bytes);}
 }
 const row={which,workflowId,runId,events:history.events.length,replay:'passed',sha256};results.push(row);console.log(JSON.stringify(row));
}
await fs.writeFile(dir+'/replay-results.json',JSON.stringify({passed:true,activityCalls:0,results},null,2),{mode:0o600});
