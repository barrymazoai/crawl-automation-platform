// Mini-only deployment and one normal Brand submission of the same ten products.
// Temporal and existing resource gates own all collection, parsing and completion.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {hostname} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pg from 'pg';
import {Client,Connection} from '@temporalio/client';
const [work]=process.argv.slice(2),main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',previous='/Users/barry/apps/crawlv3-history-20260913/amazon-unified-retest-10-20260914';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),keep=(p,v)=>fs.writeFile(p,typeof v==='string'?v:JSON.stringify(v,null,2),{flag:'wx',mode:0o600});
const run=promisify(execFile),sleep=ms=>new Promise(r=>setTimeout(r,ms)),sha=b=>createHash('sha256').update(b).digest('hex');
const tests=await read(work+'/test-results.json');assert.equal(tests.numFailedTests,0);assert.equal(tests.numPendingTests,0);assert.ok(tests.numPassedTests>=252);
const lib=await import(work+'/candidate/acceptance/purchase-conditions-inspect.js');
const manifest=main+'/live/deployment.json';let saved=await fs.readFile(manifest,'utf8');const m=JSON.parse(saved),before=await read(main+'/status.json');
assert.ok(before.jobs.every(j=>j.ready));assert.ok(Date.now()-Date.parse(before.at)<20000);
const runtime=await read(previous+'/control.runtime.json'),t=runtime.transport;
const connection=await Connection.connect({address:runtime.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
const db=new pg.Pool({connectionString:m.database.connectionString,max:1,statement_timeout:10000,options:'-c default_transaction_read_only=on'}),client=new Client({connection,namespace:runtime.namespace});
try{
 const idle=async()=>{
  const old=await client.workflow.getHandle('amazon-history-100-us-10001-20260913').query('progress');assert.equal(old.phase,'paused');assert.equal(old.cursor,24);assert.equal(old.stopAfter,24);
  assert.equal((await db.query('SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL')).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int n FROM source_submission_guard')).rows[0].n,0);
 };
 await idle();for await(const s of client.workflow.list({query:"ExecutionStatus = 'Running'"}))assert.ok(['AmazonHistoryBatchWorkflow','DtcNodeSessionWorkflow'].includes(s.type));
 const plan=await read(previous+'/temporal-plan.json');assert.equal(plan.productCount,10);const entries=plan.batches.flatMap(b=>b.entries);assert.equal(entries.length,10);
 for(const b of plan.batches){assert.deepEqual(b.scope,plan.batches[0].scope);assert.equal(b.candidateManifestSha256,plan.batches[0].candidateManifestSha256);}
 const request={...plan.batches[0],requestId:randomUUID(),entries};assert.equal(new Set(entries.map(e=>e.entry.listingId)).size,10);
 const oldConfig=m.jobs.find(j=>j.id==='amazon-capture').env.V3_AMAZON_LIVE_CONFIG,c=await read(oldConfig);
 const vision=await read(m.jobs.find(j=>j.id==='amazon-channel-label-vision').env.V3_CHANNEL_LABEL_CONFIG);
 assert.equal(lib.CodexVisionProvider.describe(vision.codex).configFingerprint,c.visionConfigFingerprint);
 assert.equal(c.deliveryPostalCode,'10001');assert.equal(c.evidencePolicy,'label-image-first/5');assert.equal(c.productResources.maxWaitSeconds,900);
 const config=lib.AmazonLiveConfigSchema.parse({...c,linkBatches:[...c.linkBatches,request]});
 const capacity=(await db.query('SELECT resource_id,capacity FROM resource_capacity WHERE resource_id=ANY($1)',[['mini-ego-space-1','mini-model-account','windows-ocr']])).rows;
 assert.equal(Number(capacity.find(r=>r.resource_id==='mini-ego-space-1').capacity),1);
 await keep(work+'/amazon.private.json',config);await keep(work+'/control.runtime.json',runtime);
 await keep(work+'/temporal-plan.json',{...plan,campaignId:'v3-collection-'+request.requestId,batches:[request]});
 await keep(work+'/deployment-before.private.json',saved);await keep(work+'/status-before.json',before);
 const priorIds=[...plan.batches.map(b=>b.requestId),(await read(previous+'/label-header-retry/started.json')).requestId];
 const priorRows=(await db.query("SELECT source_record_id,record FROM product_history_source WHERE dataset='v3:amazon' AND (record->'owner'->>'requestId'=ANY($1) OR record->'collection'->'observation'->>'requestId'=ANY($1))",[priorIds])).rows;
 const priorReviews=(await db.query("SELECT review_id,record FROM review_record WHERE record->'observation'->>'requestId'=ANY($1)",[priorIds])).rows;
 await keep(work+'/preserved-before.json',{history:priorRows.map(r=>({id:r.source_record_id,sha256:sha(Buffer.from(JSON.stringify(r.record)))})),reviews:priorReviews.map(r=>({id:r.review_id,sha256:sha(Buffer.from(JSON.stringify(r.record)))}))});
 await keep(work+'/price-baseline.json',priorRows.filter(r=>r.record.codec==='v3-capture-history/1').map(r=>r.record));
 const releases={},releaseRoot=main+'/release-amazon-throughput-20260914';await fs.mkdir(work+'/runtime',{mode:0o700});
 for(const group of ['amazon','plan','label']){
  const dest=releaseRoot+'/'+group;await fs.mkdir(dest,{recursive:true,mode:0o700});const hash=createHash('sha256');
  for(const name of (await fs.readdir(work+'/candidate/'+group)).filter(n=>n.endsWith('.js')).sort()){
   const bytes=await fs.readFile(work+'/candidate/'+group+'/'+name);await fs.writeFile(dest+'/'+name,bytes,{flag:'wx',mode:0o600});hash.update(String(bytes.length)+':').update(bytes);
  }releases[group]={dir:dest,buildId:hash.digest('hex')};
 }
 const roles=[['amazon-channel-product-input','plan'],...m.jobs.filter(j=>j.id.startsWith('amazon-channel-label-')&&!j.id.endsWith('-workflow')).map(j=>[j.id,'label']),...['control','catalog-source','catalog-ledger','product-input','file','review','capture'].map(r=>['amazon-'+r,'amazon'])];
 const entriesByGroup={amazon:'amazon-live-worker.js',plan:'channel-plan-worker.js',label:'channel-label-worker.js'},restarted=[];
 const controller=main+'/release-independent-control-20260913/independent-deployment/deployment-launchd.js';
 for(const [id,group] of roles){
  await idle();const job=m.jobs.find(j=>j.id===id),r=await read(job.env.V3_WORKER_CONFIG),release=releases[group];
  job.entry=release.dir+'/'+entriesByGroup[group];job.env.V3_WORKER_CONFIG=work+'/runtime/'+id+'.json';
  await keep(job.env.V3_WORKER_CONFIG,{...r,expectedBuildId:release.buildId});
  if(group==='amazon'){assert.equal(job.env.V3_AMAZON_LIVE_CONFIG,oldConfig);job.env.V3_AMAZON_LIVE_CONFIG=work+'/amazon.private.json';}
  assert.equal(await fs.readFile(manifest,'utf8'),saved);saved=JSON.stringify(m,null,2);await keep(manifest+'.throughput-next',saved);await fs.rename(manifest+'.throughput-next',manifest);
  const output=await run(m.node,[controller,'restart',manifest,id],{timeout:180000,maxBuffer:1048576});assert.equal(JSON.parse(output.stdout).ready[0].id,id);
  const h=await read(main+'/'+id+'.health.json');assert.equal(h.buildId,release.buildId);assert.equal(h.event,'WORKER_RUNNING');assert.notEqual(h.pid,before.jobs.find(j=>j.id===id).pid);
  assert.ok((await run('/bin/ps',['-p',String(h.pid),'-o','command='])).stdout.includes(job.entry));
  const q=await connection.workflowService.describeTaskQueue({namespace:runtime.namespace,taskQueue:{name:h.taskQueue},taskQueueType:2});assert.ok(q.pollers?.some(p=>p.identity===h.identity));
  restarted.push({id,pid:h.pid,buildId:h.buildId});await keep(work+'/restarted-'+id+'.json',restarted.at(-1));console.log(JSON.stringify({event:'THROUGHPUT_WORKER_READY',...restarted.at(-1)}));
 }
 let after;for(let n=0;n<20;n++){after=await read(main+'/status.json');if(after.jobs.every(j=>j.ready)&&Date.now()-Date.parse(after.at)<15000)break;await sleep(1000);}
 assert.ok(after.jobs.every(j=>j.ready));assert.equal(after.pid,before.pid);
 for(const job of before.jobs)if(!roles.some(([id])=>id===job.id))assert.equal(after.jobs.find(j=>j.id===job.id).pid,job.pid);
 await idle();await keep(work+'/deployment.json',{at:new Date().toISOString(),passed:true,restarted,unrelatedPidsUnchanged:true,workflowPidsUnchanged:true,capacity});
 const source=(await db.query('SELECT enabled,revision FROM brand_source WHERE id=$1',[request.scope.sourceId])).rows[0];assert.equal(source.enabled,true);assert.equal(source.revision,Number(request.scope.scopeVersion.replace('source-revision-','')));
 await keep(work+'/start-intent.json',{at:new Date().toISOString(),requestId:request.requestId,productCount:10,scope:request.scope});
 const response=await fetch('http://127.0.0.1:4188/api/v3/brands/'+request.scope.brandId+'/sources/'+request.scope.sourceId+'/submissions',{method:'POST',signal:AbortSignal.timeout(20000),headers:{'X-V3-Client':'local-workspace',Origin:'http://127.0.0.1:4188','Content-Type':'application/json','Idempotency-Key':request.requestId},body:JSON.stringify({sourceRevision:source.revision})});
 assert.ok(response.ok,'Brand submission '+response.status);const submission=await response.json();assert.equal(submission.requestId,request.requestId);assert.equal(submission.workflowId,'v3-collection-'+request.requestId);
 const started={at:new Date().toISOString(),requestId:request.requestId,workflowId:submission.workflowId,campaignId:submission.workflowId,productCount:10,scope:request.scope};
 await keep(work+'/started.json',started);console.log(JSON.stringify({event:'THROUGHPUT_TEN_SUBMITTED',...started}));
}finally{await db.end();await connection.close();}
