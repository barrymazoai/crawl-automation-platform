/** Replays closed histories locally on Mini; no Activity execution or new Workflow. */
import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {hostname} from 'node:os';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);const dir=process.argv[2],root='/Users/barry/apps/crawlv3-batch-a.UiA4dx';assert.ok(dir?.startsWith(root+'/live/channel-resident-20260910'));
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),ready=await read(dir+'/ready.json'),r=await read(dir+'/swanson-brand-workflow.runtime.json'),t=r.transport;
const require=createRequire(root+'/package.json'),{Client,Connection}=require('@temporalio/client'),{Worker}=require('@temporalio/worker');
const connection=await Connection.connect({address:r.address,tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
try{const client=new Client({connection,namespace:r.namespace}),results=[],skipped=[];
 const types=new Set(['GncLeasedProductWorkflow','CatalogWorkflow','CatalogProductWorkflow','BrandCollectionWorkflow','ScheduleIntakeWorkflow','SwansonCatalogProductWorkflow','ChannelSavedLabelWorkflow']);
 for await(const w of client.workflow.list()){
  assert.notEqual(w.status.name,'RUNNING','Drain before upgrade');if(!types.has(w.type)){skipped.push({workflowId:w.workflowId,type:w.type});continue;}
  const history=await client.workflow.getHandle(w.workflowId,w.runId).fetchHistory();
  await fs.writeFile(dir+'/evidence/history-'+w.runId+'.json',JSON.stringify(history),{mode:0o600});
  await Worker.runReplayHistory({workflowBundle:{codePath:ready.release+'/product-workflows.cjs'}},history,w.workflowId);
  const result={workflowId:w.workflowId,runId:w.runId,type:w.type,status:w.status.name,events:history.events.length,replay:'passed'};results.push(result);console.log(JSON.stringify(result));
 }
 assert.ok(results.some(r=>r.type==='GncLeasedProductWorkflow'));assert.ok(results.some(r=>r.type==='SwansonCatalogProductWorkflow'));
 await fs.writeFile(dir+'/evidence/replay.json',JSON.stringify({at:new Date().toISOString(),results,skipped,activityCalls:0},null,2));console.log(JSON.stringify({passed:results.length,skipped:skipped.length}));
}finally{await connection.close();}
