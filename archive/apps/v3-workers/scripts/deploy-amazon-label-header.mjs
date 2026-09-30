// After the ten-product retest has settled, deploy only the vision role and the
// seven Amazon roles that cache its fingerprint. Submit one failed member again
// through the normal Brand API; Temporal owns all subsequent business work.
import fs from 'node:fs/promises';
import {hostname} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import pg from 'pg';
import {Client,Connection} from '@temporalio/client';
const [work]=process.argv.slice(2),main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',batch='/Users/barry/apps/crawlv3-history-20260913/amazon-unified-retest-10-20260914';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),keep=(p,v)=>fs.writeFile(p,typeof v==='string'?v:JSON.stringify(v,null,2),{flag:'wx',mode:0o600});
const run=promisify(execFile),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const lib=await import(work+'/candidate-v7/acceptance/purchase-conditions-inspect.js');
assert.equal((await read(work+'/v7-retained-response-proof.json')).passed,true);
const tests=await read(work+'/v7-vision-tests.json');assert.equal(tests.numFailedTests,0);assert.equal(tests.numPendingTests,0);assert.equal(tests.numPassedTests,23);
const acceptance=await read(batch+'/acceptance-10.json');assert.equal(acceptance.verified,true);
const accepted=await read(acceptance.reportPath);assert.equal(accepted.expected,10);assert.equal(accepted.products.find(p=>p.asin==='B07VLV4HMF').result.status,'review');
const manifest=main+'/live/deployment.json';let saved=await fs.readFile(manifest,'utf8');const m=JSON.parse(saved),before=await read(main+'/status.json');assert.ok(before.jobs.every(j=>j.ready));assert.ok(Date.now()-Date.parse(before.at)<20000);
const r=await read(batch+'/control.runtime.json'),t=r.transport,connection=await Connection.connect({address:r.address,tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
const db=new pg.Pool({connectionString:m.database.connectionString,max:1,statement_timeout:5000,options:'-c default_transaction_read_only=on'}),client=new Client({connection,namespace:r.namespace});
const dir=batch+'/label-header-retry',controller=main+'/release-independent-control-20260913/independent-deployment/deployment-launchd.js';
try{
 const idle=async()=>{const old=await client.workflow.getHandle('amazon-history-100-us-10001-20260913').query('progress');assert.equal(old.phase,'paused');assert.equal(old.cursor,24);assert.equal((await client.workflow.getHandle(accepted.campaignId).describe()).status.name,'COMPLETED');assert.equal((await db.query('SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int n FROM source_submission_guard')).rows[0].n,0);};
 await idle();await fs.mkdir(dir,{mode:0o700});await keep(dir+'/deployment-before.private.json',saved);await keep(dir+'/status-before.json',before);
 const plan=await read(batch+'/temporal-plan.json'),prior=plan.batches.find(b=>b.entries.some(e=>e.entry.listingId==='B07VLV4HMF'));
 const request={...prior,requestId:randomUUID(),entries:prior.entries.filter(e=>e.entry.listingId==='B07VLV4HMF')};assert.equal(request.entries.length,1);
 const capture=m.jobs.find(j=>j.id==='amazon-capture'),oldConfig=capture.env.V3_AMAZON_LIVE_CONFIG,c=await read(oldConfig),vision=m.jobs.find(j=>j.id==='amazon-channel-label-vision'),vc=await read(vision.env.V3_CHANNEL_LABEL_CONFIG);
 const fingerprint=lib.CodexVisionProvider.describe(vc.codex).configFingerprint;assert.notEqual(fingerprint,c.visionConfigFingerprint);
 const config=lib.AmazonLiveConfigSchema.parse({...c,visionConfigFingerprint:fingerprint,linkBatches:[...c.linkBatches,request]});assert.equal(config.deliveryPostalCode,'10001');assert.equal(config.evidencePolicy,'label-image-first/5');await keep(dir+'/amazon.private.json',config);
 const release=main+'/release-amazon-label-header-20260914';await fs.mkdir(release,{mode:0o700});const hash=createHash('sha256');
 for(const name of (await fs.readdir(work+'/candidate-v7/label')).filter(n=>n.endsWith('.js')).sort()){const bytes=await fs.readFile(work+'/candidate-v7/label/'+name);await fs.writeFile(release+'/'+name,bytes,{flag:'wx',mode:0o600});hash.update(String(bytes.length)+':').update(bytes);}const buildId=hash.digest('hex');
 const vr=await read(vision.env.V3_WORKER_CONFIG);vision.entry=release+'/channel-label-worker.js';vision.env.V3_WORKER_CONFIG=dir+'/vision.runtime.json';await keep(vision.env.V3_WORKER_CONFIG,{...vr,expectedBuildId:buildId});
 const roles=['amazon-channel-label-vision',...['control','catalog-source','catalog-ledger','product-input','file','review','capture'].map(r=>'amazon-'+r)],restarted=[];
 for(const id of roles){
  await idle();const job=m.jobs.find(j=>j.id===id);if(id!=='amazon-channel-label-vision'){assert.equal(job.env.V3_AMAZON_LIVE_CONFIG,oldConfig);job.env.V3_AMAZON_LIVE_CONFIG=dir+'/amazon.private.json';}
  assert.equal(await fs.readFile(manifest,'utf8'),saved);saved=JSON.stringify(m,null,2);await keep(manifest+'.header-next',saved);await fs.rename(manifest+'.header-next',manifest);
  const result=await run(m.node,[controller,'restart',manifest,id],{timeout:180000,maxBuffer:1048576});assert.equal(JSON.parse(result.stdout).ready[0].id,id);
  const health=await read(main+'/'+id+'.health.json'),runtime=await read(job.env.V3_WORKER_CONFIG);assert.equal(health.buildId,runtime.expectedBuildId);assert.equal(health.event,'WORKER_RUNNING');assert.ok((await run('/bin/ps',['-p',String(health.pid),'-o','command='])).stdout.includes(job.entry));
  const pollers=await connection.workflowService.describeTaskQueue({namespace:r.namespace,taskQueue:{name:health.taskQueue},taskQueueType:2});assert.ok(pollers.pollers?.some(p=>p.identity===health.identity));
  restarted.push({id,pid:health.pid,buildId:health.buildId});console.log(JSON.stringify({event:'HEADER_ROLE_RESTARTED',...restarted.at(-1)}));
 }
 let after;for(let n=0;n<20;n++){after=await read(main+'/status.json');if(after.jobs.every(j=>j.ready)&&Date.now()-Date.parse(after.at)<15000)break;await sleep(1000);}
 assert.ok(after.jobs.every(j=>j.ready));assert.equal(after.pid,before.pid);for(const j of before.jobs)if(!roles.includes(j.id))assert.equal(after.jobs.find(n=>n.id===j.id).pid,j.pid);
 await idle();await keep(dir+'/deployment.json',{at:new Date().toISOString(),passed:true,restarted,unrelatedPidsUnchanged:true,monitorUnchanged:true,visionFingerprint:fingerprint});
 const source=(await db.query('SELECT enabled,revision FROM brand_source WHERE id=$1',[request.scope.sourceId])).rows[0];assert.equal(source.enabled,true);assert.equal(source.revision,Number(request.scope.scopeVersion.replace('source-revision-','')));
 await keep(dir+'/start-intent.json',{at:new Date().toISOString(),requestId:request.requestId,asin:'B07VLV4HMF',priorRequestId:prior.requestId,scope:request.scope});
 const response=await fetch('http://127.0.0.1:4188/api/v3/brands/'+request.scope.brandId+'/sources/'+request.scope.sourceId+'/submissions',{method:'POST',signal:AbortSignal.timeout(20000),headers:{'X-V3-Client':'local-workspace',Origin:'http://127.0.0.1:4188','Content-Type':'application/json','Idempotency-Key':request.requestId},body:JSON.stringify({sourceRevision:source.revision})});
 assert.ok(response.ok,'Brand submission '+response.status);const submission=await response.json();assert.equal(submission.requestId,request.requestId);assert.equal(submission.workflowId,'v3-collection-'+request.requestId);
 const started={at:new Date().toISOString(),requestId:request.requestId,asin:'B07VLV4HMF',workflowId:submission.workflowId,priorRequestId:prior.requestId,productCount:1,scope:request.scope};await keep(dir+'/started.json',started);console.log(JSON.stringify({event:'HEADER_RETRY_SUBMITTED',...started}));
}finally{await db.end();await connection.close();}
