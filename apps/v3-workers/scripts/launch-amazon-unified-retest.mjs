// Prepare a fresh ten-product manifest, then let Temporal run the normal Brand flow.
// Five two-product requests. Pause after the first two; runUntil(5) releases only the remaining eight.
// Does not iterate collection, reset old records or resume the paused 100-product campaign.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {hostname} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pg from 'pg';
import {Client,Connection} from '@temporalio/client';
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',history='/Users/barry/apps/crawlv3-history-20260913',old=history+'/amazon-100-us-20260913';
const dir=history+'/amazon-unified-retest-10-20260914',service=main+'/amazon-unified-retest-10-20260914',campaignId='amazon-unified-retest-10-us-10001-20260914';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),keep=(p,v)=>fs.writeFile(p,typeof v==='string'?v:JSON.stringify(v,null,2),{flag:'wx',mode:0o600});
const execute=promisify(execFile),pause=ms=>new Promise(r=>setTimeout(r,ms)),digest=b=>createHash('sha256').update(b).digest('hex');
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const mainPath=main+'/live/deployment.json',oldService=main+'/amazon-pilot-10-20260913',oldServicePath=oldService+'/deployment.json';
let mainText=await fs.readFile(mainPath,'utf8');const oldServiceText=await fs.readFile(oldServicePath,'utf8'),m=JSON.parse(mainText),p=JSON.parse(oldServiceText);
const before=await read(main+'/status.json'),beforeBatch=await read(oldService+'/status.json');
for(const s of [before,beforeBatch]){assert.ok(s.jobs.every(j=>j.ready));assert.ok(Date.now()-Date.parse(s.at)<20000);}
const roles=['amazon-control','amazon-catalog-source','amazon-catalog-ledger','amazon-product-input','amazon-file','amazon-review','amazon-capture'];
const oldConfig=m.jobs.find(j=>j.id==='amazon-capture').env.V3_AMAZON_LIVE_CONFIG,c=await read(oldConfig),bc=await read(p.jobs.find(j=>j.id==='amazon-batch-control').env.V3_AMAZON_BATCH_CONFIG);
const wr=await read(p.jobs.find(j=>j.id==='amazon-batch-workflow').env.V3_WORKER_CONFIG),t=wr.transport;
const connection=await Connection.connect({address:wr.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
const db=new pg.Pool({connectionString:c.database.connectionString,max:1,statement_timeout:5000,options:'-c default_transaction_read_only=on'});
try{
 const client=new Client({connection,namespace:wr.namespace}),previous=client.workflow.getHandle(bc.campaignId);
 const paused=async()=>{const s=await previous.query('progress');assert.equal(s.phase,'paused');assert.equal(s.cursor,24);assert.equal(s.stopAfter,24);return s;};
 const idle=async()=>{assert.equal((await db.query('SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int n FROM source_submission_guard')).rows[0].n,0);};
 await paused();await idle();assert.equal(c.deliveryPostalCode,'10001');
 for await(const s of client.workflow.list({query:"ExecutionStatus = 'Running'"}))assert.ok(['AmazonHistoryBatchWorkflow','DtcNodeSessionWorkflow'].includes(s.type));
 const deployed=await read(history+'/amazon-unified-fix-20260914/deployment.json');assert.equal(deployed.passed,true);
 for(const j of m.jobs.filter(j=>roles.includes(j.id))){
  assert.equal(j.env.V3_AMAZON_LIVE_CONFIG,oldConfig);const r=await read(j.env.V3_WORKER_CONFIG),h=await read(main+'/'+j.id+'.health.json');
  assert.equal(h.buildId,r.expectedBuildId);assert.equal(h.event,'WORKER_RUNNING');
  const hash=createHash('sha256');for(const n of (await fs.readdir(path.dirname(j.entry))).filter(n=>n.endsWith('.js')).sort()){const b=await fs.readFile(path.join(path.dirname(j.entry),n));hash.update(String(b.length)+':').update(b);}assert.equal(hash.digest('hex'),r.expectedBuildId);
  const changed=deployed.workers.find(w=>w.id===j.id);if(changed)assert.equal(r.expectedBuildId,changed.buildId);
 }
 const prior=await read(old+'/temporal-plan.json'),selected=prior.batches.slice(0,10);assert.equal(selected.length,10);assert.ok(selected.every(b=>b.entries.length===1));
 const oldIds=selected.map(b=>b.requestId),priorSubmissions=(await db.query('SELECT request_id::text id FROM collection_submission WHERE request_id=ANY($1::uuid[])',[oldIds])).rows;
 assert.equal(priorSubmissions.length,10);
 const products=selected.map(b=>prior.products.find(p=>p.asin===b.entries[0].entry.listingId));assert.ok(products.every(Boolean));assert.equal(new Set(products.map(p=>p.asin)).size,10);
 // Each two-product request uses existing CatalogWorkflow parallel children.
 // Shared browser admission remains one; labels overlap the next capture.
 const batches=[];for(let i=0;i<selected.length;i+=2){const pair=selected.slice(i,i+2);assert.equal(pair.length,2);assert.deepEqual(pair[0].scope,pair[1].scope);assert.equal(pair[0].candidateManifestSha256,pair[1].candidateManifestSha256);batches.push({...pair[0],requestId:randomUUID(),entries:pair.flatMap(b=>b.entries)});}
 assert.equal(batches.length,5);assert.equal(batches.flatMap(b=>b.entries).length,10);
 for(const b of batches){const s=(await db.query('SELECT brand_id,channel,region,url,enabled,revision FROM brand_source WHERE id=$1',[b.scope.sourceId])).rows[0];assert.ok(s?.enabled);assert.equal(s.brand_id,b.scope.brandId);assert.equal(s.channel,'amazon');assert.equal(s.region,'US');assert.equal(s.url,b.scope.rootUrl);assert.equal(s.revision,Number(b.scope.scopeVersion.replace('source-revision-','')));}
 await fs.mkdir(dir,{mode:0o700});await fs.mkdir(service,{mode:0o700});
 const plan={codec:'amazon-history-campaign/1',campaignId,region:'US',postalCode:'10001',productCount:10,products,batches};await keep(dir+'/temporal-plan.json',plan);
 const manifestSha256=digest(await fs.readFile(dir+'/temporal-plan.json'));
 const recent=(await db.query("SELECT s.record->'listing'->>'externalId' asin,o.observed_at,o.record FROM product_history_source s JOIN product_history_observation_source x USING(source_record_id) JOIN product_history_observation o USING(observation_id) WHERE s.dataset='v3:amazon' AND s.record->>'codec'='v3-capture-history/1' AND s.record->'owner'->>'requestId'=ANY($1) AND o.kind='metrics'",[oldIds])).rows;
 await keep(dir+'/price-baseline.json',[...(await read(old+'/price-baseline.json')).filter(v=>products.some(p=>p.asin===v.asin)),...recent]);
 await keep(dir+'/selection-summary.json',{at:new Date().toISOString(),campaignId,productCount:10,priorCampaignId:prior.campaignId,priorCursor:24,policy:'First ten previously submitted products, fresh request and observation identities; retain all prior observations',products:products.map((p,i)=>({asin:p.asin,url:p.url,priorRequestId:oldIds[i],requestId:batches[Math.floor(i/2)].requestId})),manifestSha256});
 await keep(dir+'/amazon.private.json',{...c,linkBatches:[...c.linkBatches,...batches]});
 await keep(dir+'/main-before.private.json',mainText);await keep(dir+'/main-status-before.json',before);await keep(dir+'/old-batch-status-before.json',beforeBatch);
 const scope='amazon-unified-retest-10-20260914',controlQueue='v3.amazon.batch.control.v1.amazon-batch-v1.session.'+scope;
 await keep(dir+'/batch.private.json',{...bc,campaignId,manifestPath:dir+'/temporal-plan.json',manifestSha256,dataRoot:dir,controlQueue});
 const oldControl=p.jobs.find(j=>j.id==='amazon-batch-control'),controlRuntime=await read(oldControl.env.V3_WORKER_CONFIG),release=service+'/release';await fs.mkdir(release,{mode:0o700});
 for(const n of (await fs.readdir(path.dirname(oldControl.entry))).filter(n=>n.endsWith('.js')||n==='amazon-batch-workflows.cjs'))await fs.copyFile(path.join(path.dirname(oldControl.entry),n),release+'/'+n,fs.constants.COPYFILE_EXCL);
 const hash=createHash('sha256');for(const n of (await fs.readdir(release)).sort()){const b=await fs.readFile(release+'/'+n);hash.update(String(b.length)+':').update(b);}assert.equal(hash.digest('hex'),controlRuntime.expectedBuildId);
 await keep(dir+'/control.runtime.json',{...controlRuntime,hostId:'mini-amazon-purchase-retest-control',queueScope:scope});
 const newService={...p,root:service,jobs:[{...oldControl,entry:release+'/amazon-batch-worker.js',env:{...oldControl.env,V3_WORKER_CONFIG:dir+'/control.runtime.json',V3_AMAZON_BATCH_CONFIG:dir+'/batch.private.json'}}],resources:[],dependencyProbes:[]};await keep(service+'/deployment.json',newService);
 const controller=main+'/release-independent-control-20260913/independent-deployment/deployment-launchd.js',ready=[];
 for(const id of roles){
  await paused();await idle();const j=m.jobs.find(j=>j.id===id);j.env.V3_AMAZON_LIVE_CONFIG=dir+'/amazon.private.json';
  assert.equal(await fs.readFile(mainPath,'utf8'),mainText);mainText=JSON.stringify(m,null,2);await keep(mainPath+'.purchase-retest-next',mainText);await fs.rename(mainPath+'.purchase-retest-next',mainPath);
  const output=await execute(m.node,[controller,'restart',mainPath,id],{timeout:180000,maxBuffer:1048576});const row=JSON.parse(output.stdout).ready[0];assert.equal(row.id,id);ready.push(row);console.log(JSON.stringify({event:'RETEST_INPUT_LOADED',...row}));
 }
 const output=await execute(m.node,[controller,'start',service+'/deployment.json','amazon-batch-control'],{timeout:180000,maxBuffer:1048576});assert.equal(JSON.parse(output.stdout).ready[0].id,'amazon-batch-control');
 let current;for(let n=0;n<20;n++){current=await read(main+'/status.json');if(current.jobs.every(j=>j.ready)&&Date.now()-Date.parse(current.at)<15000)break;await pause(1000);}
 assert.ok(current.jobs.every(j=>j.ready));assert.equal(current.pid,before.pid);
 for(const j of before.jobs)if(!roles.includes(j.id))assert.equal(current.jobs.find(n=>n.id===j.id).pid,j.pid);
 const oldStatus=await read(oldService+'/status.json');assert.equal(oldStatus.pid,beforeBatch.pid);for(const j of beforeBatch.jobs)assert.equal(oldStatus.jobs.find(n=>n.id===j.id).pid,j.pid);
 assert.equal(await fs.readFile(oldServicePath,'utf8'),oldServiceText);
 const ch=await read(service+'/amazon-batch-control.health.json');assert.equal(ch.buildId,controlRuntime.expectedBuildId);assert.equal(ch.taskQueue,controlQueue);
 let polling=false;for(let n=0;n<10;n++){const q=await connection.workflowService.describeTaskQueue({namespace:wr.namespace,taskQueue:{name:controlQueue},taskQueueType:2});polling=!!q.pollers?.some(p=>p.identity===ch.identity);if(polling)break;await pause(1000);}assert.ok(polling);
 const resources=(await db.query("SELECT resource_id,healthy,health_until>now() fresh FROM resource_capacity WHERE resource_id=ANY($1)",[['mini-ego-space-1','mini-model-account','windows-ocr']])).rows;assert.equal(resources.length,3);assert.ok(resources.every(r=>r.healthy&&r.fresh));await idle();await paused();
 const workflowQueue=(await read(oldService+'/amazon-batch-workflow.health.json')).taskQueue;
 await keep(dir+'/start-intent.json',{at:new Date().toISOString(),campaignId,manifestSha256,productCount:10,workflowQueue,controlQueue});
 const handle=await client.workflow.start('AmazonHistoryBatchWorkflow',{workflowId:campaignId,taskQueue:workflowQueue,args:[{campaignId,manifestSha256,controlQueue,stopAfter:1}],workflowIdReusePolicy:'REJECT_DUPLICATE'});
 const d=await handle.describe();assert.equal(d.status.name,'RUNNING');
 const receipt={at:new Date().toISOString(),campaignId,runId:d.runId,productCount:10,chunks:5,stopAfter:1,manifestSha256,workflowQueue,controlQueue,controlPid:ch.pid,ready,oldCampaignPausedAt:24,oldCampaignWorkersUnchanged:true,unrelatedPidsUnchanged:true,businessReleasesUnchanged:true,productsPerChunk:2,initialProductLimit:2,region:'US',postalCode:'10001'};
 await keep(dir+'/started.json',receipt);console.log(JSON.stringify(receipt));console.log(JSON.stringify({progress:await handle.query('progress')}));
}finally{await db.end();await connection.close();}
