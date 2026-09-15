// Update only resource-finalizer consumers. Existing campaign/workers keep their queues and configs.
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {hostname} from 'node:os';import {createHash} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import pg from 'pg';import {Connection,Client} from '@temporalio/client';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',work='/Users/barry/apps/crawlv3-history-20260913/resource-finally-20260915',dtc=main+'/dtc-innerbody-v2-20260911';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),keep=(p,v)=>fs.writeFile(p,typeof v==='string'?v:JSON.stringify(v,null,2),{flag:'wx',mode:0o600}),run=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
const test=await read(work+'/test-results.json'),replay=await read(work+'/replay-results.json');assert.equal(test.numFailedTests,0);assert.equal(test.numPassedTests,140);assert.equal(test.numPendingTests,0);assert.equal(replay.passed,true);assert.equal(replay.bundleSha256,sha(await fs.readFile(work+'/candidate/workflow/product-workflows.cjs')));assert.equal((await read(work+'/empty-ocr-audit.json')).request.permitId,'permit-01a0a2f2-d4dd-7061-b230-8abfd325926f-8');
const paths=[main+'/live/deployment.json',dtc+'/private/deployment.json'],texts=await Promise.all(paths.map(p=>fs.readFile(p,'utf8'))),before=texts.map(JSON.parse),after=before.map(m=>structuredClone(m)),states=await Promise.all(before.map(m=>read(m.root+'/status.json')));
const scopes=[{label:['channel-label-ocr','channel-label-text','channel-label-vision','channel-label-resources','amazon-channel-label-ocr','amazon-channel-label-text','amazon-channel-label-vision','amazon-channel-label-resources'],workflow:['gnc-core-stream-workflow','catalog-workflow','swanson-product-workflow','swanson-catalog-workflow','channel-label-workflow','amazon-product-workflow','amazon-catalog-workflow','amazon-channel-label-workflow']},{label:['channel-label-ocr','channel-label-text','channel-label-vision','channel-label-resources'],workflow:['dtc-product-workflow','catalog-workflow','channel-label-workflow']}];
const rt=await read(before[0].jobs.find(j=>j.id==='amazon-channel-label-ocr').env.V3_WORKER_CONFIG),t=rt.transport,c=await Connection.connect({address:rt.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}}),client=new Client({connection:c,namespace:rt.namespace}),db=new pg.Pool({connectionString:before[0].database.connectionString,max:1,statement_timeout:10000,options:'-c default_transaction_read_only=on'});
try{
 for(const s of states){assert.ok(s.jobs.every(j=>j.ready));assert.ok(Date.now()-Date.parse(s.at)<20000);}
 const idle=async()=>{
  const p=await client.workflow.getHandle('amazon-night-350-us-10001-20260914').query('progress');assert.equal(p.phase,'blocked');assert.equal(p.cursor,13);
  const held=(await db.query('SELECT permit_id FROM resource_permit WHERE released_at IS NULL')).rows;assert.deepEqual(held.map(x=>x.permit_id),['permit-01a0a2f2-d4dd-7061-b230-8abfd325926f-8']);
  for await(const e of client.workflow.list({query:"ExecutionStatus = 'Running'"})){assert.ok(['AmazonHistoryBatchWorkflow','DtcNodeSessionWorkflow','BrandCollectionWorkflow','CatalogWorkflow'].includes(e.type),'Active business owner '+e.type);}
 };
 await idle();await fs.mkdir(work+'/runtime',{mode:0o700});const expected=new Map();
 for(let i=0;i<after.length;i++){
  await keep(work+'/deployment-before-'+i+'.private.json',texts[i]);await keep(work+'/status-before-'+i+'.json',states[i]);
  for(const [group,ids] of Object.entries(scopes[i])){
   const dest=after[i].root+'/release-resource-finally-20260915/'+group;await fs.mkdir(dest,{recursive:true,mode:0o700});const h=createHash('sha256');
   for(const n of (await fs.readdir(work+'/candidate/'+group)).filter(n=>n.endsWith('.js')||n==='product-workflows.cjs').sort()){
    const b=await fs.readFile(work+'/candidate/'+group+'/'+n);await fs.writeFile(dest+'/'+n,b,{flag:'wx',mode:0o600});h.update(String(b.length)+':').update(b);
   }const buildId=h.digest('hex');
   for(const id of ids){const j=after[i].jobs.find(j=>j.id===id);assert.ok(j);const old=await read(j.env.V3_WORKER_CONFIG);j.entry=dest+'/'+(group==='label'?'channel-label-worker.js':'product-workflow-worker.js');j.env.V3_WORKER_CONFIG=work+'/runtime/'+i+'-'+id+'.json';await keep(j.env.V3_WORKER_CONFIG,{...old,expectedBuildId:buildId});expected.set(i+'/'+id,{buildId,entry:j.entry,kind:group==='label'?2:1});}
  }
  for(const old of before[i].jobs)if(!expected.has(i+'/'+old.id))assert.deepEqual(after[i].jobs.find(j=>j.id===old.id),old);
  await keep(work+'/deployment-after-'+i+'.private.json',after[i]);
 }
 // Start verifier/provider roles before workflows can request the new proof format.
 const controller=main+'/release-independent-control-20260913/independent-deployment/deployment-launchd.js',restarted=[];
 for(let i=0;i<after.length;i++){
  await idle();assert.equal(await fs.readFile(paths[i],'utf8'),texts[i]);await keep(paths[i]+'.resource-finally-next',after[i]);await fs.rename(paths[i]+'.resource-finally-next',paths[i]);
  for(const id of [...scopes[i].label,...scopes[i].workflow]){
   const result=await run('/opt/homebrew/bin/node',[controller,'restart',paths[i],id],{timeout:180000,maxBuffer:1048576});assert.equal(JSON.parse(result.stdout).ready[0].id,id);
   const h=await read(after[i].root+'/'+id+'.health.json'),e=expected.get(i+'/'+id);assert.equal(h.event,'WORKER_RUNNING');assert.equal(h.buildId,e.buildId);assert.notEqual(h.pid,states[i].jobs.find(j=>j.id===id).pid);assert.ok((await run('/bin/ps',['-p',String(h.pid),'-o','command='])).stdout.includes(e.entry));
   const q=await c.workflowService.describeTaskQueue({namespace:rt.namespace,taskQueue:{name:h.taskQueue},taskQueueType:e.kind});assert.ok(q.pollers?.some(p=>p.identity===h.identity));
   const receipt={deployment:i,id,pid:h.pid,buildId:h.buildId};restarted.push(receipt);await keep(work+'/restarted-'+i+'-'+id+'.json',receipt);console.log(JSON.stringify({event:'RESOURCE_FINALIZER_READY',...receipt}));
  }
 }
 const samples=[];for(let n=0;n<3;n++){
  await new Promise(r=>setTimeout(r,6000));const snapshots=await Promise.all(after.map(m=>read(m.root+'/status.json')));
  for(let i=0;i<snapshots.length;i++){const s=snapshots[i];assert.ok(s.jobs.every(j=>j.ready));assert.ok(Date.now()-Date.parse(s.at)<20000);assert.equal(s.pid,states[i].pid);for(const old of states[i].jobs)if(!expected.has(i+'/'+old.id))assert.equal(s.jobs.find(j=>j.id===old.id).pid,old.pid);}
  samples.push({at:new Date().toISOString(),ready:snapshots.map(s=>s.jobs.length)});
 }
 await idle();const receipt={at:new Date().toISOString(),passed:true,restarted,samples,unrelatedPidsUnchanged:true,windowsBrowserWorkersUnchanged:true,batchWorkersUnchanged:true};await keep(work+'/deployment.json',receipt);console.log(JSON.stringify({event:'RESOURCE_FINALIZER_DEPLOYED',workers:restarted.length,passed:true}));
}finally{await db.end();await c.close();}
