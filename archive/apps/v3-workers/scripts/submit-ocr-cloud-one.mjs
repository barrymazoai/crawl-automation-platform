// One-product rehearsal for cloud-mode OCR: submit a single ASIN through the normal Brand API, wait for the
// product to finish, then verify from Temporal history + ledger + R2 that OCR returned `uploaded` from the
// cloud-mode worker and the Mini receipt registered it. Usage: node submit-ocr-cloud-one.mjs [ASIN]
import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {hostname} from 'node:os';import {randomUUID,createHash} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import pg from 'pg';import {Client,Connection} from '@temporalio/client';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',history='/Users/barry/apps/crawlv3-history-20260913',work=history+'/ocr-cloud-20260915',plan2000=history+'/amazon-2000-us-20260913/temporal-plan.json';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),keep=(p,v)=>fs.writeFile(p,typeof v==='string'?v:JSON.stringify(v,null,2),{flag:'wx',mode:0o600}),run=promisify(execFile),pause=ms=>new Promise(r=>setTimeout(r,ms));
const deployed=await read(work+'/deployment.json');assert.equal(deployed.passed,true);assert.equal(deployed.ocrMode,'upload-only');
const manifestPath=main+'/live/deployment.json',text=await fs.readFile(manifestPath,'utf8'),m=JSON.parse(text);
const status=await read(main+'/status.json');assert.ok(status.jobs.every(j=>j.ready));assert.ok(Date.now()-Date.parse(status.at)<20000);
const source=m.jobs.find(j=>j.id==='amazon-catalog-source'),liveConfigPath=source.env.V3_AMAZON_LIVE_CONFIG,live=await read(liveConfigPath);
const ocrJob=m.jobs.find(j=>j.id==='amazon-channel-label-ocr'),rt=await read(ocrJob.env.V3_WORKER_CONFIG),t=rt.transport,cloudPrivate=await read(ocrJob.env.V3_CHANNEL_LABEL_CONFIG);
assert.equal(cloudPrivate.database,undefined,'OCR worker must be ledger-less');assert.equal(rt.hostId,'mini-amazon-ocr-cloud');
const labelPrivate=await read(m.jobs.find(j=>j.id==='amazon-channel-label-ocr-receipts').env.V3_CHANNEL_LABEL_CONFIG);
const connection=await Connection.connect({address:rt.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
const db=new pg.Pool({connectionString:labelPrivate.database.connectionString,max:1,statement_timeout:5000,options:'-c default_transaction_read_only=on'});
const api=async(p,method='GET',body,key)=>{const r=await fetch('http://127.0.0.1:4188/api/v3'+p,{method,signal:AbortSignal.timeout(15000),headers:{'X-V3-Client':'local-workspace',...(method!=='GET'?{Origin:'http://127.0.0.1:4188','Content-Type':'application/json','Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});if(r.status===404&&method==='GET')return null;if(!r.ok)throw Error('API_'+r.status+' '+(await r.text()).slice(0,200));return r.json();};
try{
 const client=new Client({connection,namespace:rt.namespace});
 const idle=async()=>{assert.equal((await db.query('SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int n FROM source_submission_guard')).rows[0].n,0);
  for await(const s of client.workflow.list({query:"ExecutionStatus = 'Running'"}))assert.ok(['AmazonHistoryBatchWorkflow','DtcNodeSessionWorkflow'].includes(s.type),'running '+s.type);};
 await idle();
 // Pick one not-yet-attempted ASIN from the 2000 plan (or the one given on the command line).
 const plan=await read(plan2000),attempted=new Set((await db.query("SELECT DISTINCT record->'entry'->>'listingId' asin FROM catalog_discovery WHERE record->'scope'->>'channel'='amazon'")).rows.map(r=>r.asin));
 const asin=process.argv[2]??plan.products.find(p=>!attempted.has(p.asin)).asin;assert.ok(asin);const product=plan.products.find(p=>p.asin===asin);assert.ok(product,'ASIN not in plan');
 const template=plan.batches.find(b=>b.entries.some(e=>e.entry.listingId===asin));assert.ok(template);
 const requestId=randomUUID(),batch={...template,requestId,entries:template.entries.filter(e=>e.entry.listingId===asin)};assert.equal(batch.entries.length,1);
 const src=(await db.query('SELECT brand_id,channel,region,enabled FROM brand_source WHERE id=$1',[batch.scope.sourceId])).rows[0];assert.ok(src?.enabled);assert.equal(src.channel,'amazon');assert.equal(src.brand_id,batch.scope.brandId);
 const dir=work+'/one-'+asin;await fs.mkdir(dir,{mode:0o700});
 await keep(dir+'/link-batch.json',batch);await keep(dir+'/amazon.private.json',{...live,linkBatches:[...(live.linkBatches??[]),batch]});
 // Only the catalog-source role resolves link batches; rebind it to the extended config and restart it.
 const controller=main+'/release-independent-control-20260913/independent-deployment/deployment-launchd.js';
 const next=structuredClone(m);next.jobs.find(j=>j.id==='amazon-catalog-source').env.V3_AMAZON_LIVE_CONFIG=dir+'/amazon.private.json';
 await keep(dir+'/deployment-before.private.json',text);await keep(manifestPath+'.one-next',next);await fs.rename(manifestPath+'.one-next',manifestPath);
 const restart=async id=>{const r=await run('/opt/homebrew/bin/node',[controller,'restart',manifestPath,id],{timeout:180000,maxBuffer:1048576});assert.equal(JSON.parse(r.stdout).ready[0].id,id);const h=await read(main+'/'+id+'.health.json');assert.equal(h.event,'WORKER_RUNNING');return h;};
 await restart('amazon-catalog-source');
 await keep(dir+'/submit-intent.json',{at:new Date().toISOString(),requestId,asin,brandId:batch.scope.brandId,sourceId:batch.scope.sourceId});
 const submission=await api('/brands/'+batch.scope.brandId+'/sources/'+batch.scope.sourceId+'/submissions','POST',{sourceRevision:Number(batch.scope.scopeVersion.replace('source-revision-',''))},requestId);
 assert.equal(submission.requestId,requestId);assert.equal(submission.workflowId,'v3-collection-'+requestId);await keep(dir+'/submission.json',submission);
 console.log(JSON.stringify({event:'ONE_SUBMITTED',requestId,asin,workflowId:submission.workflowId}));
 const root=client.workflow.getHandle(submission.workflowId);const started=Date.now();let described;
 for(;;){described=await root.describe();if(described.status.name!=='RUNNING')break;if(Date.now()-started>25*60000)throw Error('ONE_TIMEOUT');await pause(15000);}
 console.log(JSON.stringify({event:'ONE_ROOT_'+described.status.name,elapsedSeconds:Math.round((Date.now()-started)/1000)}));
 const discoveries=(await db.query('SELECT record FROM catalog_discovery WHERE catalog_id=$1',[requestId])).rows.map(r=>r.record);assert.equal(discoveries.length,1);
 const productId=discoveries[0].workflowId,labelId=productId+'-label',decode=p=>JSON.parse(Buffer.from(p.data).toString());
 const evidence={requestId,asin,root:{status:described.status.name},workflows:{}};
 for(const id of [productId,labelId]){
  const h=client.workflow.getHandle(id),d=await h.describe(),hist=await h.fetchHistory();const acts=new Map(),rows=[];
  for(const e of hist.events){
   if(e.activityTaskScheduledEventAttributes)acts.set(String(e.eventId),{name:e.activityTaskScheduledEventAttributes.activityType.name,activityId:e.activityTaskScheduledEventAttributes.activityId});
   if(e.activityTaskStartedEventAttributes){const a=acts.get(String(e.activityTaskStartedEventAttributes.scheduledEventId));if(a)a.identity=e.activityTaskStartedEventAttributes.identity;}
   if(e.activityTaskCompletedEventAttributes){const a=acts.get(String(e.activityTaskCompletedEventAttributes.scheduledEventId));if(a){const p=e.activityTaskCompletedEventAttributes.result?.payloads?.[0];a.result=p?decode(p):null;rows.push(a);}}
   if(e.activityTaskFailedEventAttributes){const a=acts.get(String(e.activityTaskFailedEventAttributes.scheduledEventId));if(a){a.failed=e.activityTaskFailedEventAttributes.failure?.message?.slice(0,200);rows.push(a);}}
  }
  evidence.workflows[id]={type:d.type,status:d.status.name,events:hist.events.length,activities:rows.map(a=>({name:a.name,activityId:a.activityId,identity:a.identity,status:a.result?.status??(a.failed?'FAILED':'?'),...(a.name==='ocrFile'?{result:a.result}:{}),...(a.name==='resolveOcrReceipt'?{receipt:a.result?.status,registration:!!a.result?.registration}:{}),...(a.failed?{failed:a.failed}:{})}))};
 }
 const label=evidence.workflows[labelId],ocr=label?.activities.filter(a=>a.name==='ocrFile')??[],receipts=label?.activities.filter(a=>a.name==='resolveOcrReceipt')??[];
 const cloud=ocr.filter(a=>a.identity?.startsWith('mini-amazon-ocr-cloud/')),uploaded=ocr.filter(a=>a.status==='uploaded');
 const permits=(await db.query('SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL')).rows[0].n;
 const collected=(await db.query("SELECT count(*)::int n FROM collected_product WHERE record->'observation'->>'listingId'=$1",[asin])).rows[0].n;
 const reviews=(await db.query("SELECT record->'failure'->>'code' code,record->'failure'->>'stage' stage FROM review_record WHERE record->'observation'->>'listingId'=$1 AND registered_at>now()-interval '1 hour'",[asin])).rows;
 const registered=(await db.query("SELECT count(*)::int n FROM processing_result WHERE record->'input'->>'listingId'=$1",[asin]).catch(()=>({rows:[{n:'table-unknown'}]}))).rows[0].n;
 Object.assign(evidence,{summary:{ocrCalls:ocr.length,fromCloudWorker:cloud.length,uploadedOutcomes:uploaded.length,receipts:receipts.map(r=>r.receipt),heldPermits:permits,collectedProducts:collected,reviews,ocrRegistered:registered}});
 await keep(dir+'/evidence.json',evidence);console.log('EVIDENCE '+JSON.stringify(evidence.summary));
 for(const id of [productId,labelId])console.log(id,JSON.stringify(evidence.workflows[id]?.activities.map(a=>[a.name,a.status,a.identity?.split('/')[0]])));
 // Restore the catalog-source binding to the canonical config; the extended copy is retained under the work dir.
 const restore=JSON.parse(await fs.readFile(manifestPath,'utf8'));restore.jobs.find(j=>j.id==='amazon-catalog-source').env.V3_AMAZON_LIVE_CONFIG=liveConfigPath;
 await keep(manifestPath+'.one-restore',restore);await fs.rename(manifestPath+'.one-restore',manifestPath);await restart('amazon-catalog-source');
 await idle();console.log(JSON.stringify({event:'ONE_DONE',passed:cloud.length>0&&uploaded.length===ocr.length&&receipts.every(r=>r==='registered')&&permits===0}));
}finally{await db.end();await connection.close();}
