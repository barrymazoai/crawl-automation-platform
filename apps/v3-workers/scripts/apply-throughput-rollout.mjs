// Mini, fleet STOPPED only. One-shot rollout of the 2026-09-15 throughput changes on the Amazon set:
//   1. migration 020 (product_enrichment) on the V3 test database;
//   2. release copy of the candidate builds (label / workflow / plan / amazon / batch) and their build ids;
//   3. a new Amazon private config: ScraperAPI capture + direct CDN images, enrichment queue + gate, no pinned postal code;
//   4. rebinding of the 29 Amazon jobs in the main manifest and the 2 batch jobs, per-process concurrency
//      (mini OCR 4, text 4, vision 4, collection 2), ledger + manifest capacities (model 14, cpu 14, windows-ocr 10)
//      and the new `scraperapi-lane` admission resource (40);
//   5. a preflight start of every rebound worker on a throw-away queue scope (WORKER_RUNNING or abort).
// The script never starts the fleet. Original files are retained; every write uses the `wx` flag.
//   node apply-throughput-rollout.mjs --check   # read-only rehearsal: preconditions, migration status, config + manifest validation
//   node apply-throughput-rollout.mjs           # apply
import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {hostname} from 'node:os';import {createHash} from 'node:crypto';import {execFile,spawn} from 'node:child_process';import {promisify} from 'node:util';import pg from 'pg';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const check=process.argv.includes('--check');
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',batchRoot=main+'/amazon-pilot-10-20260913',work='/Users/barry/apps/crawlv3-history-20260913/ocr-cloud-20260915',candidate=work+'/candidate',releaseDir=main+'/release-throughput-20260915',out=work+'/rollout',runtimeDir=work+'/runtime-throughput';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),keep=async(p,v)=>{if(check)return;const b=typeof v==='string'?v:JSON.stringify(v,null,2);try{await fs.writeFile(p,b,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;assert.equal(await fs.readFile(p,'utf8'),b,'existing file differs: '+p);}},mkdir=async p=>{if(!check)await fs.mkdir(p,{recursive:true,mode:0o700});},sha=b=>createHash('sha256').update(b).digest('hex'),run=promisify(execFile),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const exists=p=>fs.stat(p).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
const capacities={'mini-model-account':14,'mini-cpu':14,'windows-ocr':10};
const lane={resourceId:'scraperapi-lane',capacity:40,jobs:['amazon-capture','amazon-file','amazon-catalog-source'],minFreeBytes:1073741824,dependencies:['r2-read']};
const concurrency={'amazon-channel-label-ocr':4,'amazon-channel-label-text':4,'amazon-channel-label-vision':4,'amazon-channel-label-collection':2};
const groups={label:['channel-label-worker.js'],workflow:['product-workflow-worker.js','product-workflows.cjs'],plan:['channel-plan-worker.js'],amazon:['amazon-live-worker.js'],batch:['amazon-batch-worker.js','amazon-batch-workflows.cjs']};
const workflowJobs=['amazon-product-workflow','amazon-catalog-workflow','amazon-brand-workflow','amazon-channel-label-workflow'],amazonJobs=['amazon-control','amazon-catalog-source','amazon-catalog-ledger','amazon-product-input','amazon-capture','amazon-file','amazon-review'];
const groupFor=id=>workflowJobs.includes(id)?'workflow':id.startsWith('amazon-channel-label-')?'label':id==='amazon-channel-product-input'?'plan':amazonJobs.includes(id)?'amazon':null;
// --- preconditions: both monitors stopped, nothing loaded in launchd, candidate proven.
const status=await read(main+'/status.json'),batchStatus=await read(batchRoot+'/status.json');
assert.equal(status.status,'monitor-stopped','main fleet must be stopped');assert.equal(batchStatus.status,'monitor-stopped','batch monitor must be stopped');
assert.equal((await run('/bin/launchctl',['list'])).stdout.split('\n').filter(l=>l.includes('com.crawlv3')).length,0,'launchd services still loaded');
for(const f of [main+'/supervisor.lock',batchRoot+'/supervisor.lock'])assert.equal(await exists(f),false,f);
const tests=await read(work+'/test-results-20260915b.json');assert.equal(tests.numFailedTests,0);assert.ok(tests.numPassedTests>=241,'candidate tests '+tests.numPassedTests);
const replay=await read(work+'/replay-results.json');assert.equal(replay.passed,true);assert.equal(replay.bundleSha256,sha(await fs.readFile(candidate+'/workflow/product-workflows.cjs')),'replayed bundle must be the candidate bundle');
assert.equal(await exists(out+'/receipt.json'),false,'rollout already applied (receipt exists)');
const apiKey=(await fs.readFile(work+'/private/scraperapi.key','utf8')).trim();assert.match(apiKey,/^[A-Za-z0-9_-]{8,512}$/);
const manifestPath=main+'/live/deployment.json',text=await fs.readFile(manifestPath,'utf8'),before=JSON.parse(text),after=structuredClone(before);
const batchManifestPath=batchRoot+'/deployment.json',batchText=await fs.readFile(batchManifestPath,'utf8'),batchBefore=JSON.parse(batchText),batchAfter=structuredClone(batchBefore);
const {AmazonLiveConfigSchema}=await import(candidate+'/amazon-config/amazon-live-config.js'),{DeploymentSchema}=await import(candidate+'/amazon-config/deployment-supervisor.js');
const {MultipartOcr}=await import(candidate+'/amazon-config/ocr-http.js');
const receiptsPrivate=await read(before.jobs.find(j=>j.id==='amazon-channel-label-ocr-receipts').env.V3_CHANNEL_LABEL_CONFIG);
const db=new pg.Pool({connectionString:receiptsPrivate.database.connectionString,max:1,connectionTimeoutMillis:5000,statement_timeout:15000});
try{
 assert.equal((await db.query('SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL')).rows[0].n,0,'held permits');
 await mkdir(out);await mkdir(runtimeDir);await mkdir(out+'/preflight');
 await keep(out+'/deployment-before.private.json',text);await keep(out+'/batch-deployment-before.private.json',batchText);await keep(out+'/status-before.json',status);
 // --- 1. migration 020, the same ledger protocol as v3-api bootstrap `migrate` (advisory lock, sha-checked ledger).
 const migrations=(await fs.readdir(candidate+'/migrations')).filter(n=>/^\d{3}_.*\.sql$/.test(n)).sort();assert.equal(migrations.at(-1),'020_product_enrichment.sql');
 const applied=(await db.query('SELECT name,sha256 FROM public.v3_local_migration ORDER BY name')).rows;
 for(const [i,row] of applied.entries()){assert.equal(row.name,migrations[i]);assert.equal(row.sha256,sha(await fs.readFile(candidate+'/migrations/'+row.name)),'migration changed: '+row.name);}
 const pending=migrations.slice(applied.length);assert.ok(pending.every(n=>n==='020_product_enrichment.sql'),'unexpected pending migrations '+JSON.stringify(pending));
 if(pending.length&&!check){const c=await db.connect();try{
   await c.query('BEGIN');await c.query("SET LOCAL search_path=public; SET LOCAL lock_timeout='5s'");await c.query('SELECT pg_advisory_xact_lock(73110311)');
   assert.equal((await c.query('SELECT count(*)::int n FROM public.v3_local_migration')).rows[0].n,applied.length);
   const sql=await fs.readFile(candidate+'/migrations/020_product_enrichment.sql','utf8');assert.ok(/^[\s\S]*?\bBEGIN;/.test(sql)&&/COMMIT;\s*$/.test(sql),'migration must be transactional');
   await c.query(sql.replace(/\bBEGIN;/,'').replace(/COMMIT;\s*$/,''));await c.query('INSERT INTO public.v3_local_migration VALUES ($1,$2)',['020_product_enrichment.sql',sha(Buffer.from(sql))]);await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}}
 if(!check){await db.query('SELECT enrichment_id,listing_id,formula_hash,protocol,collection_operation_id,record_hash,record,registered_at FROM public.product_enrichment LIMIT 0');
 const trigger=await db.query("SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.product_enrichment') AND tgname='product_enrichment_immutable' AND NOT tgisinternal");assert.equal(trigger.rowCount,1,'enrichment immutability trigger');}
 // --- 2. release copy; build id = the worker's own rule (sorted .js, plus the workflow bundle for workflow/batch workers).
 const builds={};
 for(const [group,files] of Object.entries(groups)){
  const dest=releaseDir+'/'+group;await mkdir(dest);const h=createHash('sha256');
  for(const n of [...files].sort()){const b=await fs.readFile(candidate+'/'+group+'/'+n);if(!check)try{await fs.writeFile(dest+'/'+n,b,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;assert.ok((await fs.readFile(dest+'/'+n)).equals(b),'release file differs: '+n);}h.update(String(b.length)+':').update(b);}
  builds[group]={dest,entry:dest+'/'+files[0],buildId:h.digest('hex')};
 }
 // --- 3. Amazon private config: ScraperAPI static HTML, direct CDN originals, enrichment wired to the collection queue.
 const oldAmazonPath=before.jobs.find(j=>j.id==='amazon-capture').env.V3_AMAZON_LIVE_CONFIG,oldAmazon=await read(oldAmazonPath);
 for(const id of amazonJobs)assert.equal(before.jobs.find(j=>j.id===id).env.V3_AMAZON_LIVE_CONFIG,oldAmazonPath,'Amazon jobs must share one config');
 const {deliveryPostalCode:_zip,...rest}=oldAmazon,modelNeeds=oldAmazon.labelResources.activities.interpretText;assert.ok(Array.isArray(modelNeeds)&&modelNeeds.length);
 // OCR compatibility is recomputed under the address-independent fingerprint rule of this build, from Mini's own OCR provider config.
 const ocrPrivate=await read(before.jobs.find(j=>j.id==='amazon-channel-label-ocr').env.V3_CHANNEL_LABEL_CONFIG),ocrSupported=new MultipartOcr(ocrPrivate.ocrProvider).supported;assert.notEqual(ocrSupported.configFingerprint,oldAmazon.ocr.configFingerprint);
 const amazon=AmazonLiveConfigSchema.parse({...rest,ocr:ocrSupported,
  capture:{mode:'scraperapi',route:{routeId:'scraperapi-us',version:'scraperapi/1',egressId:'scraperapi-us/1',mode:'scraperapi',managed:true,countryCode:'us',sessionNumber:null,responseMode:'html',providerPolicy:'scraperapi-sync/1'},scraperApi:{apiKey,allowedOrigins:['https://www.amazon.com']},images:'direct'},
  browserResource:lane.resourceId,egressId:'direct/1',productQueues:{...oldAmazon.productQueues,enrich:oldAmazon.labelQueues.collection},
  productResources:{...oldAmazon.productResources,activities:{...oldAmazon.productResources.activities,browserSession:[{resourceId:lane.resourceId,units:1}],enrichProduct:modelNeeds}}});
 const amazonPrivate=work+'/private/amazon-scraperapi.private.json';await keep(amazonPrivate,amazon);
 // --- 4. rebind jobs and resources.
 const changed=[];
 for(const j of after.jobs){const g=groupFor(j.id);if(!g)continue;const rt=await read(j.env.V3_WORKER_CONFIG);
  const runtime={...rt,expectedBuildId:builds[g].buildId,...(concurrency[j.id]?{concurrency:concurrency[j.id]}:{})};
  j.entry=builds[g].entry;j.env={...j.env,V3_WORKER_CONFIG:runtimeDir+'/'+j.id+'.json',...(g==='amazon'?{V3_AMAZON_LIVE_CONFIG:amazonPrivate}:{})};
  await keep(j.env.V3_WORKER_CONFIG,runtime);changed.push({id:j.id,group:g,concurrency:runtime.concurrency,queueScope:runtime.queueScope});}
 assert.equal(changed.length,17+4+1+7,'expected 29 Amazon jobs, got '+changed.length);
 for(const old of before.jobs)if(!changed.some(c=>c.id===old.id))assert.deepEqual(after.jobs.find(j=>j.id===old.id),old);
 for(const id of Object.keys(capacities))assert.ok(before.resources.some(r=>r.resourceId===id),id);
 assert.ok(!before.resources.some(r=>r.resourceId===lane.resourceId));
 after.resources=[...after.resources.map(r=>capacities[r.resourceId]!==undefined?{...r,capacity:capacities[r.resourceId]}:r),lane];
 for(const id of lane.jobs)assert.ok(after.jobs.some(j=>j.id===id),id);
 DeploymentSchema.parse(after);
 const batchChanged=[];
 for(const j of batchAfter.jobs){const rt=await read(j.env.V3_WORKER_CONFIG);j.entry=builds.batch.entry;j.env={...j.env,V3_WORKER_CONFIG:runtimeDir+'/batch-'+j.id+'.json'};await keep(j.env.V3_WORKER_CONFIG,{...rt,expectedBuildId:builds.batch.buildId});batchChanged.push({id:j.id,queueScope:rt.queueScope});}
 assert.equal(batchChanged.length,2);DeploymentSchema.parse(batchAfter);
 // --- 5. preflight: every rebound worker boots on a throw-away scope and reports WORKER_RUNNING with the expected build id.
 const preflight=async(manifest,j)=>{
  const rt=await read(j.env.V3_WORKER_CONFIG),probe={...rt,queueScope:'throughput-preflight-20260915',hostId:'mini-preflight-'+j.id},cp=out+'/preflight/'+j.id+'.runtime.json',health=out+'/preflight/'+j.id+'.health.json';
  await keep(cp,probe);const log=await fs.open(out+'/preflight/'+j.id+'.log','a',0o600);
  const child=spawn(manifest.node,[j.entry],{env:{...process.env,...j.env,V3_WORKER_CONFIG:cp,V3_WORKER_HEALTH_FILE:health},stdio:['ignore',log.fd,log.fd]});await log.close();
  let h=null;try{const until=Date.now()+90000;while(Date.now()<until&&child.exitCode===null){try{const c=await read(health);if(c.pid===child.pid&&c.event==='WORKER_RUNNING'){h=c;break;}}catch{}await sleep(500);}}
  finally{if(child.exitCode===null){child.kill('SIGTERM');const until=Date.now()+30000;while(child.exitCode===null&&Date.now()<until)await sleep(200);if(child.exitCode===null)child.kill('SIGKILL');}}
  assert.ok(h,'preflight not ready: '+j.id+' (see '+out+'/preflight/'+j.id+'.log)');assert.equal(h.buildId,rt.expectedBuildId,'build id '+j.id);
  return{id:j.id,pid:child.pid,buildId:h.buildId,taskQueue:h.taskQueue,exitCode:child.exitCode};
 };
 const preflightSkipped=['amazon-batch-control'];
 const targets=[...changed.map(c=>[after,after.jobs.find(j=>j.id===c.id)]),...batchChanged.filter(c=>!preflightSkipped.includes(c.id)).map(c=>[batchAfter,batchAfter.jobs.find(j=>j.id===c.id)])],checks=[];
 if(!check)for(let i=0;i<targets.length;i+=5)checks.push(...await Promise.all(targets.slice(i,i+5).map(([m,j])=>preflight(m,j))));
 // --- 6. ledger, then manifests (last, atomically).
 const ledgerBefore=(await db.query('SELECT resource_id,capacity,controller,healthy,reason FROM resource_capacity ORDER BY resource_id')).rows;
 if(check){console.log(JSON.stringify({event:'THROUGHPUT_ROLLOUT_CHECKED',builds:Object.fromEntries(Object.entries(builds).map(([g,b])=>[g,b.buildId])),jobs:changed.length+batchChanged.length,migrationPending:pending,capacities,lane:lane.capacity,capture:{mode:amazon.capture.mode,lane:amazon.browserResource,egressId:amazon.egressId,enrichQueue:amazon.productQueues.enrich},ledger:ledgerBefore,concurrency:changed.filter(c=>concurrency[c.id]).map(c=>[c.id,c.concurrency])}));}
 else{
 for(const [id,cap] of Object.entries(capacities)){const r=await db.query("UPDATE resource_capacity SET capacity=$2,controller=NULL,healthy=false,health_until=now(),reason=$3 WHERE resource_id=$1",[id,cap,'capacity_change_'+cap]);assert.equal(r.rowCount,1,id);}
 await db.query("INSERT INTO resource_capacity(resource_id,capacity,reason) VALUES($1,$2,'lane_added') ON CONFLICT (resource_id) DO UPDATE SET capacity=EXCLUDED.capacity,controller=NULL,healthy=false,health_until=now(),reason='lane_added'",[lane.resourceId,lane.capacity]);
 const ledgerAfter=(await db.query('SELECT resource_id,capacity,controller,healthy,reason FROM resource_capacity ORDER BY resource_id')).rows;
 assert.equal(await fs.readFile(manifestPath,'utf8'),text);assert.equal(await fs.readFile(batchManifestPath,'utf8'),batchText);
 await keep(out+'/deployment-after.private.json',after);await keep(out+'/batch-deployment-after.private.json',batchAfter);
 await keep(manifestPath+'.throughput-next',after);await fs.rename(manifestPath+'.throughput-next',manifestPath);
 await keep(batchManifestPath+'.throughput-next',batchAfter);await fs.rename(batchManifestPath+'.throughput-next',batchManifestPath);
 const receipt={at:new Date().toISOString(),passed:true,builds,migrationApplied:pending,amazonPrivate,capture:{mode:amazon.capture.mode,route:amazon.capture.route,images:amazon.capture.images,lane:amazon.browserResource,egressId:amazon.egressId,enrichQueue:amazon.productQueues.enrich},ocr:{before:oldAmazon.ocr.configFingerprint,after:ocrSupported.configFingerprint},
  changed,batchChanged,capacities,lane,ledgerBefore,ledgerAfter,preflight:checks,preflightSkipped,tests:{passed:tests.numPassedTests,failed:tests.numFailedTests},replay:{bundleSha256:replay.bundleSha256}};
 await keep(out+'/receipt.json',receipt);
 console.log(JSON.stringify({event:'THROUGHPUT_ROLLOUT_APPLIED',builds:Object.fromEntries(Object.entries(builds).map(([g,b])=>[g,b.buildId])),jobs:changed.length+batchChanged.length,migrationApplied:pending,capacities,lane:lane.capacity,preflightReady:checks.length}));
 }
}finally{await db.end();}
