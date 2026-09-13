// Start one immutable, exactly-100 campaign on the existing independent Mini services.
// Temporal runs business iteration; this process only prepares configuration and starts it.
import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {hostname} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import pg from 'pg';import {Client,Connection,WorkflowExecutionAlreadyStartedError} from '@temporalio/client';
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',history='/Users/barry/apps/crawlv3-history-20260913',full=history+'/amazon-2000-us-20260913',dir=history+'/amazon-100-us-20260913',pilot=main+'/amazon-pilot-10-20260913';
const campaignId='amazon-history-100-us-10001-20260913',read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const keep=(p,v)=>fs.writeFile(p,typeof v==='string'?v:JSON.stringify(v,null,2),{flag:'wx',mode:0o600}),sleep=ms=>new Promise(r=>setTimeout(r,ms)),execute=promisify(execFile);
const digest=b=>createHash('sha256').update(b).digest('hex');
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const mainPath=main+'/live/deployment.json',pilotPath=pilot+'/deployment.json',mainText=await fs.readFile(mainPath,'utf8'),pilotText=await fs.readFile(pilotPath,'utf8'),m=JSON.parse(mainText),p=JSON.parse(pilotText);
const before=await read(main+'/status.json'),beforePilot=await read(pilot+'/status.json');
for(const [s,n] of [[before,90],[beforePilot,2]]){assert.equal(s.mode,'independent');assert.equal(s.jobs.length,n);assert.ok(s.jobs.every(j=>j.ready));assert.ok(Date.now()-Date.parse(s.at)<20000);}
const roles=['amazon-control','amazon-catalog-source','amazon-catalog-ledger','amazon-product-input','amazon-capture','amazon-file','amazon-review'];
const oldConfig=m.jobs.find(j=>j.id==='amazon-file').env.V3_AMAZON_LIVE_CONFIG,c=await read(oldConfig),bc=await read(p.jobs[0].env.V3_AMAZON_BATCH_CONFIG);
assert.equal(c.deliveryPostalCode,'10001');assert.equal(c.linkBatches.length,512);assert.equal(bc.campaignId,'amazon-history-5-us-10001-20260913');
const rt=await read(p.jobs.find(j=>j.id==='amazon-batch-workflow').env.V3_WORKER_CONFIG),t=rt.transport;
const connection=await Connection.connect({address:rt.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
const db=new pg.Pool({connectionString:c.database.connectionString,max:1,connectionTimeoutMillis:5000,statement_timeout:5000});
try{
 const client=new Client({connection,namespace:rt.namespace});
 for(const [id,state] of [['amazon-history-2000-us-10001-20260913','CANCELLED'],['amazon-history-10-us-10001-20260913','CANCELLED'],[bc.campaignId,'COMPLETED'],['v3-collection-9d2ae9d0-f953-49fb-bdbe-28a560177f93','COMPLETED']])assert.equal((await client.workflow.getHandle(id).describe()).status.name,state);
 const idle=async()=>{assert.equal((await db.query('select count(*)::int n from resource_permit where released_at is null')).rows[0].n,0);assert.equal((await db.query('select count(*)::int n from source_submission_guard')).rows[0].n,0);};await idle();
 // Confirm actual release bytes still match each runtime before reusing it.
 for(const jobs of [m.jobs.filter(j=>roles.includes(j.id)),p.jobs])for(const j of jobs){const r=await read(j.env.V3_WORKER_CONFIG),folder=j.entry.slice(0,j.entry.lastIndexOf('/')),hash=createHash('sha256');
  const names=(await fs.readdir(folder)).filter(n=>n.endsWith('.js')||j.id.startsWith('amazon-batch-')&&n==='amazon-batch-workflows.cjs').sort();
  for(const name of names){const bytes=await fs.readFile(folder+'/'+name);hash.update(String(bytes.length)+':').update(bytes);}assert.equal(hash.digest('hex'),r.expectedBuildId);
  if(roles.includes(j.id))assert.equal(r.expectedBuildId,'b3bb8e7bd190c0bb05e9fee157da692a042c8fb940c71b3d7224f069f650bb15');
 }
 const selection=await read(full+'/selection.json'),original=await read(full+'/link-batches.json'),baseline=await read(full+'/price-baseline.json');
 const attempted=new Set((await db.query("select distinct record->'entry'->>'listingId' asin from catalog_discovery where record->'scope'->>'channel'='amazon'")).rows.map(x=>x.asin));
 const priced=new Set(baseline.filter(x=>x.observed_at&&x.record.currency==='USD'&&x.record.price!==null&&x.record.price!==undefined&&String(x.record.price).trim()!==''&&Number.isFinite(Number(x.record.price))).map(x=>x.asin));
 const candidates=selection.groups.flatMap(g=>g.products.map(p=>({...p,legacyGroup:g.name}))).filter(p=>!attempted.has(p.asin));
 const products=[...candidates.filter(p=>priced.has(p.asin)),...candidates.filter(p=>!priced.has(p.asin))].slice(0,100);assert.equal(products.length,100);assert.equal(new Set(products.map(p=>p.asin)).size,100);
 const batches=products.map(product=>{const originals=original.filter(b=>b.entries.some(e=>e.entry.listingId===product.asin));assert.equal(originals.length,1);const b=originals[0],entry=b.entries.find(e=>e.entry.listingId===product.asin);assert.equal(entry.candidateId,product.candidateId);assert.equal(entry.historyListingId,product.historyListingId);assert.equal(entry.entry.url,product.url);return{...b,requestId:randomUUID(),entries:[entry]};});
 for(const scope of new Map(batches.map(b=>[b.scope.sourceId,b.scope])).values()){
  const s=(await db.query('select id,brand_id,channel,region,url,enabled,revision from brand_source where id=$1',[scope.sourceId])).rows[0];assert.ok(s?.enabled);assert.equal(s.brand_id,scope.brandId);assert.equal(s.channel,'amazon');assert.equal(s.region,'US');assert.equal(s.url,scope.rootUrl);assert.equal(s.revision,Number(scope.scopeVersion.replace('source-revision-','')));
 }
 await fs.mkdir(dir,{mode:0o700});
 const plan={codec:'amazon-history-campaign/1',campaignId,region:'US',postalCode:'10001',productCount:100,products,batches};await keep(dir+'/temporal-plan.json',plan);
 const manifestSha256=digest(await fs.readFile(dir+'/temporal-plan.json'));
 await keep(dir+'/price-baseline.json',baseline.filter(x=>products.some(p=>p.asin===x.asin)));
 await keep(dir+'/selection-summary.json',{at:new Date().toISOString(),campaignId,products:100,chunks:100,manifestSha256,withOldUsdPrice:products.filter(p=>priced.has(p.asin)).length,priorAttemptedExcluded:attempted.size,policy:'Original 2,000-product candidate order; exclude prior discovered ASINs; prefer existing USD price observations; one immutable request per product',groups:[...new Set(products.map(p=>p.legacyGroup))],firstAsins:products.slice(0,5).map(p=>p.asin)});
 const nextConfig={...c,linkBatches:[...c.linkBatches,...batches]};assert.equal(nextConfig.linkBatches.length,612);await keep(dir+'/amazon.private.json',nextConfig);
 const nextBatch={...bc,campaignId,manifestPath:dir+'/temporal-plan.json',manifestSha256,dataRoot:dir};await keep(dir+'/batch.private.json',nextBatch);
 const after=structuredClone(m),afterPilot=structuredClone(p);
 for(const j of after.jobs)if(roles.includes(j.id)){assert.equal(j.env.V3_AMAZON_LIVE_CONFIG,oldConfig);j.env.V3_AMAZON_LIVE_CONFIG=dir+'/amazon.private.json';}
 for(const j of afterPilot.jobs)j.env.V3_AMAZON_BATCH_CONFIG=dir+'/batch.private.json';
 await keep(dir+'/main-before.private.json',mainText);await keep(dir+'/batch-before.private.json',pilotText);await keep(dir+'/main-status-before.json',before);await keep(dir+'/batch-status-before.json',beforePilot);
 await keep(dir+'/main-after.private.json',after);await keep(dir+'/batch-after.private.json',afterPilot);
 await idle();assert.equal(await fs.readFile(mainPath,'utf8'),mainText);assert.equal(await fs.readFile(pilotPath,'utf8'),pilotText);
 for(const [path,v] of [[mainPath,after],[pilotPath,afterPilot]]){await keep(path+'.100-next',v);await fs.rename(path+'.100-next',path);}
 const control=main+'/release-independent-control-20260913/independent-deployment/deployment-launchd.js',ready=[];
 for(const [path,id] of [...roles.map(id=>[mainPath,id]),...p.jobs.map(j=>[pilotPath,j.id])]){const out=await execute(m.node,[control,'restart',path,id],{timeout:180000,maxBuffer:1024*1024});const result=JSON.parse(out.stdout);assert.equal(result.ready[0].id,id);ready.push(result.ready[0]);console.log(JSON.stringify({event:'CONFIG_LOADED',...result.ready[0]}));}
 let current,currentPilot;for(let n=0;n<30;n++){current=await read(main+'/status.json');currentPilot=await read(pilot+'/status.json');if([current,currentPilot].every(s=>s.jobs.every(j=>j.ready)&&Date.now()-Date.parse(s.at)<15000))break;await sleep(1000);}assert.ok([current,currentPilot].every(s=>s.jobs.every(j=>j.ready)));assert.equal(current.pid,before.pid);assert.equal(currentPilot.pid,beforePilot.pid);
 for(const j of before.jobs)if(!roles.includes(j.id))assert.equal(current.jobs.find(n=>n.id===j.id).pid,j.pid);
 const resources=(await db.query("select resource_id,healthy,health_until>now() fresh from resource_capacity where resource_id=ANY($1)",[['mini-ego-space-1','mini-model-account','windows-ocr']])).rows;assert.equal(resources.length,3);assert.ok(resources.every(x=>x.healthy&&x.fresh));await idle();
 const workflowQueue=(await read(pilot+'/amazon-batch-workflow.health.json')).taskQueue;
 await keep(dir+'/start-intent.json',{at:new Date().toISOString(),campaignId,manifestSha256,productCount:100,workflowQueue,controlQueue:bc.controlQueue});
 let handle;try{handle=await client.workflow.start('AmazonHistoryBatchWorkflow',{workflowId:campaignId,taskQueue:workflowQueue,args:[{campaignId,manifestSha256,controlQueue:bc.controlQueue}],workflowIdReusePolicy:'REJECT_DUPLICATE'});}catch(error){if(!(error instanceof WorkflowExecutionAlreadyStartedError))throw error;handle=client.workflow.getHandle(campaignId);}
 const d=await handle.describe();assert.equal(d.status.name,'RUNNING');assert.equal(d.type,'AmazonHistoryBatchWorkflow');
 const receipt={at:new Date().toISOString(),campaignId,runId:d.runId,productCount:100,chunks:100,manifestSha256,workflowQueue,controlQueue:bc.controlQueue,ready,mainMonitorPid:current.pid,batchMonitorPid:currentPilot.pid,unrelatedPidsUnchanged:true,businessReleaseUnchanged:true,region:'US',postalCode:'10001'};
 await keep(dir+'/started.json',receipt);console.log(JSON.stringify(receipt));console.log(JSON.stringify({progress:await handle.query('progress')}));
}finally{await db.end();await connection.close();}
