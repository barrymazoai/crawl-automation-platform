// SUPERSEDED by apply-throughput-rollout.mjs (2026-09-15); kept as the record of the Mini-only rehearsal design.
// Cloud-mode OCR rehearsal on Mini: switch the Amazon OCR worker to a ledger-less (upload-only) config and
// move the Amazon receipt, resource-verifier and label-workflow workers to the candidate build.
// No new jobs (the independent monitor rejects topology changes); bindings of four existing jobs change.
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {hostname} from 'node:os';import {createHash} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import pg from 'pg';import {Client,Connection} from '@temporalio/client';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',work='/Users/barry/apps/crawlv3-history-20260913/ocr-cloud-20260915',releaseName='release-ocr-cloud-20260915';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),keep=(p,v)=>fs.writeFile(p,typeof v==='string'?v:JSON.stringify(v,null,2),{flag:'wx',mode:0o600}),run=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
const test=await read(work+'/test-results.json'),replay=await read(work+'/replay-results.json');
assert.equal(test.numFailedTests,0);assert.ok(test.numPassedTests>=108);assert.equal(replay.passed,true);assert.equal(replay.bundleSha256,sha(await fs.readFile(work+'/candidate/workflow/product-workflows.cjs')));
const manifestPath=main+'/live/deployment.json',text=await fs.readFile(manifestPath,'utf8'),before=JSON.parse(text),after=structuredClone(before),status=await read(main+'/status.json');
assert.ok(status.jobs.every(j=>j.ready));assert.ok(Date.now()-Date.parse(status.at)<20000);
const jobs={ocr:'amazon-channel-label-ocr',receipts:'amazon-channel-label-ocr-receipts',resources:'amazon-channel-label-resources',workflow:'amazon-channel-label-workflow'};
const ocrJob=before.jobs.find(j=>j.id===jobs.ocr),rt=await read(ocrJob.env.V3_WORKER_CONFIG),t=rt.transport,labelPrivate=await read(ocrJob.env.V3_CHANNEL_LABEL_CONFIG);
const c=await Connection.connect({address:rt.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
const db=new pg.Pool({connectionString:labelPrivate.database.connectionString,max:1,statement_timeout:5000,options:'-c default_transaction_read_only=on'});
try{
 const client=new Client({connection:c,namespace:rt.namespace});
 const idle=async()=>{
  assert.equal((await db.query('SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL')).rows[0].n,0,'held permits');
  for await(const e of client.workflow.list({query:"ExecutionStatus = 'Running'"}))assert.ok(['AmazonHistoryBatchWorkflow','DtcNodeSessionWorkflow'].includes(e.type),'Active business workflow '+e.type);
 };
 await idle();
 await fs.mkdir(work+'/runtime',{recursive:true,mode:0o700});await fs.mkdir(work+'/private',{recursive:true,mode:0o700});
 await keep(work+'/deployment-before.private.json',text);await keep(work+'/status-before.json',status);
 const builds={};
 for(const group of ['label','workflow']){
  const dest=main+'/'+releaseName+'/'+group;await fs.mkdir(dest,{recursive:true,mode:0o700});const h=createHash('sha256');
  for(const n of (await fs.readdir(work+'/candidate/'+group)).filter(n=>n.endsWith('.js')||n==='product-workflows.cjs').sort()){
   const b=await fs.readFile(work+'/candidate/'+group+'/'+n);await fs.writeFile(dest+'/'+n,b,{flag:'wx',mode:0o600});h.update(String(b.length)+':').update(b);
  }
  builds[group]={dest,buildId:h.digest('hex')};
 }
 // Cloud-mode private config: identical to the local-mode OCR config minus the ledger. Same root keeps the OCR journal probe valid.
 const {database:_db,resourceDatabase:_rdb,...cloudPrivate}=labelPrivate;assert.ok(cloudPrivate.ocrProvider);
 await keep(work+'/private/label-ocr-cloud.private.json',cloudPrivate);
 const expected=new Map();
 for(const [kind,id] of Object.entries(jobs)){
  const j=after.jobs.find(j=>j.id===id);assert.ok(j,id);const old=await read(j.env.V3_WORKER_CONFIG),group=kind==='workflow'?'workflow':'label';
  j.entry=builds[group].dest+'/'+(group==='label'?'channel-label-worker.js':'product-workflow-worker.js');
  const runtime={...old,expectedBuildId:builds[group].buildId,...(kind==='ocr'?{hostId:'mini-amazon-ocr-cloud',concurrency:1}:{})};
  j.env={...j.env,V3_WORKER_CONFIG:work+'/runtime/'+id+'.json',...(kind==='ocr'?{V3_CHANNEL_LABEL_CONFIG:work+'/private/label-ocr-cloud.private.json'}:{})};
  await keep(j.env.V3_WORKER_CONFIG,runtime);expected.set(id,{buildId:builds[group].buildId,kind:group==='workflow'?1:2,hostId:runtime.hostId});
 }
 for(const old of before.jobs)if(!expected.has(old.id))assert.deepEqual(after.jobs.find(j=>j.id===old.id),old);
 await keep(work+'/deployment-after.private.json',after);
 await idle();assert.equal(await fs.readFile(manifestPath,'utf8'),text);
 await keep(manifestPath+'.ocr-cloud-next',after);await fs.rename(manifestPath+'.ocr-cloud-next',manifestPath);
 const controller=main+'/release-independent-control-20260913/independent-deployment/deployment-launchd.js',restarted=[];
 // Order: receipt/verifier first (they must understand `uploaded` before any cloud OCR result exists), then workflow, then the OCR worker itself.
 for(const id of [jobs.receipts,jobs.resources,jobs.workflow,jobs.ocr]){
  const result=await run('/opt/homebrew/bin/node',[controller,'restart',manifestPath,id],{timeout:180000,maxBuffer:1048576});assert.equal(JSON.parse(result.stdout).ready[0].id,id);
  const h=await read(main+'/'+id+'.health.json'),e=expected.get(id);assert.equal(h.event,'WORKER_RUNNING');assert.equal(h.buildId,e.buildId);assert.notEqual(h.pid,status.jobs.find(j=>j.id===id).pid);
  assert.ok(h.identity.startsWith(e.hostId+'/'),'identity '+h.identity);
  const q=await c.workflowService.describeTaskQueue({namespace:rt.namespace,taskQueue:{name:h.taskQueue},taskQueueType:e.kind});assert.ok(q.pollers?.some(p=>p.identity===h.identity),'poller '+id);
  const receipt={id,pid:h.pid,buildId:h.buildId,identity:h.identity,taskQueue:h.taskQueue};restarted.push(receipt);await keep(work+'/restarted-'+id+'.json',receipt);console.log(JSON.stringify({event:'OCR_CLOUD_WORKER_READY',...receipt}));
 }
 const samples=[];for(let n=0;n<3;n++){await new Promise(r=>setTimeout(r,6000));const s=await read(main+'/status.json');assert.ok(s.jobs.every(j=>j.ready));assert.ok(Date.now()-Date.parse(s.at)<20000);assert.equal(s.pid,status.pid);
  for(const old of status.jobs)if(!expected.has(old.id))assert.equal(s.jobs.find(j=>j.id===old.id).pid,old.pid);samples.push({at:new Date().toISOString(),ready:s.jobs.length});}
 const health=(await db.query("SELECT resource_id,healthy,health_until>now() fresh,reason FROM resource_capacity WHERE resource_id='windows-ocr'")).rows[0];assert.ok(health.healthy&&health.fresh,JSON.stringify(health));
 await idle();const receipt={at:new Date().toISOString(),passed:true,builds,restarted,samples,ocrMode:'upload-only',unrelatedPidsUnchanged:true};await keep(work+'/deployment.json',receipt);console.log(JSON.stringify({event:'OCR_CLOUD_DEPLOYED',...receipt}));
}finally{await db.end();await c.close();}
