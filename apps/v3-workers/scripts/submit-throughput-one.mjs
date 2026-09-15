// One-product test after apply-throughput-rollout.mjs (fleet running): submit a single ASIN through the normal
// Brand API, wait for the product to finish, then read Temporal history + ledger for the evidence of the four
// changes: ScraperAPI capture (fetchedVia.mode=http), OCR outcome per host (registered on Mini, uploaded from a
// cloud worker) and its receipt, formula reuse (reusedFormula) and enrichment (enrichProduct / product_enrichment).
// Usage: node submit-throughput-one.mjs [ASIN]      (default: the next never-attempted ASIN of the 2000 plan)
import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {hostname} from 'node:os';import {randomUUID} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import pg from 'pg';import {Client,Connection} from '@temporalio/client';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',history='/Users/barry/apps/crawlv3-history-20260913',work=history+'/ocr-cloud-20260915',plan2000=history+'/amazon-2000-us-20260913/temporal-plan.json';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),keep=(p,v)=>fs.writeFile(p,typeof v==='string'?v:JSON.stringify(v,null,2),{flag:'wx',mode:0o600}),run=promisify(execFile),pause=ms=>new Promise(r=>setTimeout(r,ms));
const rollout=await read(work+'/rollout/receipt.json');assert.equal(rollout.passed,true);assert.equal(rollout.capture.mode,'scraperapi');
const manifestPath=main+'/live/deployment.json',text=await fs.readFile(manifestPath,'utf8'),m=JSON.parse(text);
const status=await read(main+'/status.json');assert.ok(status.jobs.every(j=>j.ready),'fleet not ready');assert.ok(Date.now()-Date.parse(status.at)<20000,'status stale');
const source=m.jobs.find(j=>j.id==='amazon-catalog-source'),liveConfigPath=source.env.V3_AMAZON_LIVE_CONFIG,live=await read(liveConfigPath);assert.equal(live.capture.mode,'scraperapi');assert.ok(live.productQueues.enrich);
const rt=await read(source.env.V3_WORKER_CONFIG),t=rt.transport;
const labelPrivate=await read(m.jobs.find(j=>j.id==='amazon-channel-label-ocr-receipts').env.V3_CHANNEL_LABEL_CONFIG);
const connection=await Connection.connect({address:rt.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
const db=new pg.Pool({connectionString:labelPrivate.database.connectionString,max:1,statement_timeout:5000,options:'-c default_transaction_read_only=on'});
const api=async(p,method='GET',body,key)=>{const r=await fetch('http://127.0.0.1:4188/api/v3'+p,{method,signal:AbortSignal.timeout(15000),headers:{'X-V3-Client':'local-workspace',...(method!=='GET'?{Origin:'http://127.0.0.1:4188','Content-Type':'application/json','Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});if(r.status===404&&method==='GET')return null;if(!r.ok)throw Error('API_'+r.status+' '+await r.text());return r.json();};
const find=(v,key)=>{if(!v||typeof v!=='object')return undefined;if(key in v)return v[key];for(const x of Object.values(v)){const f=find(x,key);if(f!==undefined)return f;}return undefined;};
try{
 const client=new Client({connection,namespace:rt.namespace});
 const idle=async()=>{assert.equal((await db.query('SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL')).rows[0].n,0,'held permits');
  for await(const s of client.workflow.list({query:"ExecutionStatus = 'Running'"}))assert.ok(['AmazonHistoryBatchWorkflow','DtcNodeSessionWorkflow'].includes(s.type),'running '+s.type);};
 await idle();
 const plan=await read(plan2000),attempted=new Set((await db.query("SELECT DISTINCT record->'entry'->>'listingId' asin FROM catalog_discovery WHERE record->'scope'->>'channel'='amazon'")).rows.map(r=>r.asin));
 const asin=process.argv[2]??plan.products.find(p=>!attempted.has(p.asin)).asin;assert.ok(asin);assert.ok(plan.products.some(p=>p.asin===asin),'ASIN not in plan');
 const template=plan.batches.find(b=>b.entries.some(e=>e.entry.listingId===asin));assert.ok(template);
 const requestId=randomUUID(),batch={...template,requestId,entries:template.entries.filter(e=>e.entry.listingId===asin)};assert.equal(batch.entries.length,1);
 const src=(await db.query('SELECT brand_id,channel,region,enabled FROM brand_source WHERE id=$1',[batch.scope.sourceId])).rows[0];assert.ok(src?.enabled);assert.equal(src.channel,'amazon');assert.equal(src.brand_id,batch.scope.brandId);
 const priorFormula=(await db.query("SELECT count(*)::int n FROM collected_product WHERE record->'observation'->>'listingId'=$1",[asin])).rows[0].n;
 const priorEnrichment=(await db.query('SELECT count(*)::int n FROM product_enrichment WHERE listing_id=$1',[asin])).rows[0].n;
 const dir=work+'/one-'+asin+'-'+requestId.slice(0,8);await fs.mkdir(dir,{mode:0o700});
 await keep(dir+'/link-batch.json',batch);await keep(dir+'/amazon.private.json',{...live,linkBatches:[...(live.linkBatches??[]),batch]});
 // Only the catalog-source role resolves link batches; rebind it to the extended config and restart it.
 const controller=main+'/release-independent-control-20260913/independent-deployment/deployment-launchd.js';
 const next=structuredClone(m);next.jobs.find(j=>j.id==='amazon-catalog-source').env.V3_AMAZON_LIVE_CONFIG=dir+'/amazon.private.json';
 await keep(dir+'/deployment-before.private.json',text);await keep(manifestPath+'.one-next',next);await fs.rename(manifestPath+'.one-next',manifestPath);
 const restart=async id=>{const r=await run('/opt/homebrew/bin/node',[controller,'restart',manifestPath,id],{timeout:180000,maxBuffer:1048576});assert.equal(JSON.parse(r.stdout).ready[0].id,id);const h=await read(main+'/'+id+'.health.json');assert.equal(h.event,'WORKER_RUNNING');return h;};
 await restart('amazon-catalog-source');
 await keep(dir+'/submit-intent.json',{at:new Date().toISOString(),requestId,asin,brandId:batch.scope.brandId,sourceId:batch.scope.sourceId,priorFormula,priorEnrichment});
 const submission=await api('/brands/'+batch.scope.brandId+'/sources/'+batch.scope.sourceId+'/submissions','POST',{sourceRevision:Number(batch.scope.scopeVersion.replace('source-revision-',''))},requestId);
 assert.equal(submission.requestId,requestId);assert.equal(submission.workflowId,'v3-collection-'+requestId);await keep(dir+'/submission.json',submission);
 console.log(JSON.stringify({event:'ONE_SUBMITTED',requestId,asin,workflowId:submission.workflowId,priorFormula,priorEnrichment}));
 const root=client.workflow.getHandle(submission.workflowId);const started=Date.now();let described;
 for(;;){described=await root.describe();if(described.status.name!=='RUNNING')break;if(Date.now()-started>25*60000)throw Error('ONE_TIMEOUT');await pause(15000);}
 console.log(JSON.stringify({event:'ONE_ROOT_'+described.status.name,elapsedSeconds:Math.round((Date.now()-started)/1000)}));
 const discoveries=(await db.query('SELECT record FROM catalog_discovery WHERE catalog_id=$1',[requestId])).rows.map(r=>r.record);assert.equal(discoveries.length,1);
 const productId=discoveries[0].workflowId,labelId=productId+'-label',decode=p=>JSON.parse(Buffer.from(p.data).toString());
 const evidence={requestId,asin,root:{status:described.status.name},workflows:{}};
 for(const id of [productId,labelId]){
  const h=client.workflow.getHandle(id);let d;try{d=await h.describe();}catch{evidence.workflows[id]={status:'NOT_STARTED'};continue;}
  const hist=await h.fetchHistory();const acts=new Map(),rows=[];let result=null;
  for(const e of hist.events){
   if(e.activityTaskScheduledEventAttributes)acts.set(String(e.eventId),{name:e.activityTaskScheduledEventAttributes.activityType.name,activityId:e.activityTaskScheduledEventAttributes.activityId});
   if(e.activityTaskStartedEventAttributes){const a=acts.get(String(e.activityTaskStartedEventAttributes.scheduledEventId));if(a)a.identity=e.activityTaskStartedEventAttributes.identity;}
   if(e.activityTaskCompletedEventAttributes){const a=acts.get(String(e.activityTaskCompletedEventAttributes.scheduledEventId));if(a){const p=e.activityTaskCompletedEventAttributes.result?.payloads?.[0];a.result=p?decode(p):null;rows.push(a);}}
   if(e.activityTaskFailedEventAttributes){const a=acts.get(String(e.activityTaskFailedEventAttributes.scheduledEventId));if(a){a.failed=e.activityTaskFailedEventAttributes.failure?.message?.slice(0,200);rows.push(a);}}
   if(e.workflowExecutionCompletedEventAttributes){const p=e.workflowExecutionCompletedEventAttributes.result?.payloads?.[0];result=p?decode(p):null;}
  }
  evidence.workflows[id]={type:d.type,status:d.status.name,events:hist.events.length,result:result&&{status:result.status,reusedFormula:result.reusedFormula??false,code:result.code},
   activities:rows.map(a=>({name:a.name,activityId:a.activityId,identity:a.identity,status:a.result?.status??(a.failed?'FAILED':'?'),
    ...(a.name==='captureAmazonProduct'?{fetchedVia:find(a.result,'fetchedVia')??null,parentAsin:find(a.result,'parentAsin')??null}:{}),
    ...(a.name==='ocrFile'?{host:a.identity?.split('/')[0]}:{}),...(a.name==='resolveOcrReceipt'?{receipt:a.result?.status,registration:!!a.result?.registration}:{}),
    ...(a.name==='inspectExistingFormula'?{existing:a.result}:{}),...(a.name==='enrichProduct'?{enrichment:a.result}:{}),...(a.failed?{failed:a.failed}:{})}))};
 }
 const product=evidence.workflows[productId],label=evidence.workflows[labelId],all=[...(product?.activities??[]),...(label?.activities??[])];
 const capture=all.find(a=>a.name==='captureAmazonProduct'),ocr=all.filter(a=>a.name==='ocrFile'),receipts=all.filter(a=>a.name==='resolveOcrReceipt'),enrich=all.filter(a=>a.name==='enrichProduct'),inspect=all.find(a=>a.name==='inspectExistingFormula');
 const permits=(await db.query('SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL')).rows[0].n;
 const collected=(await db.query("SELECT count(*)::int n FROM collected_product WHERE record->'observation'->>'listingId'=$1",[asin])).rows[0].n;
 const enrichment=(await db.query("SELECT enrichment_id,protocol,record->'candidate' candidate,registered_at FROM product_enrichment WHERE listing_id=$1 ORDER BY registered_at",[asin])).rows;
 const reviews=(await db.query("SELECT record->'failure'->>'code' code,record->'failure'->>'stage' stage FROM review_record WHERE record->'observation'->>'listingId'=$1 AND registered_at>now()-interval '1 hour'",[asin])).rows;
 const summary={rootStatus:described.status.name,productStatus:product?.result?.status??product?.status,reusedFormula:product?.result?.reusedFormula??false,existingFormula:inspect?.existing??null,
  captureVia:capture?.fetchedVia??null,parentAsin:capture?.parentAsin??null,
  ocr:{calls:ocr.length,byHost:Object.fromEntries(ocr.map(a=>[a.host,(ocr.filter(b=>b.host===a.host).length)])),outcomes:ocr.map(a=>a.status),receipts:receipts.map(r=>r.receipt)},
  enrich:{calls:enrich.length,outcomes:enrich.map(a=>a.enrichment&&{status:a.enrichment.status,reused:a.enrichment.reused,code:a.enrichment.code}),rowsBefore:priorEnrichment,rowsAfter:enrichment.length,candidate:enrichment.at(-1)?.candidate??null},
  collectedProducts:collected,heldPermits:permits,reviews};
 Object.assign(evidence,{summary});await keep(dir+'/evidence.json',evidence);console.log('EVIDENCE '+JSON.stringify(summary));
 for(const id of [productId,labelId])console.log(id,JSON.stringify(evidence.workflows[id]?.activities?.map(a=>[a.name,a.status,a.identity?.split('/')[0]])));
 // Restore the catalog-source binding to the canonical config; the extended copy is retained under the work dir.
 const restore=JSON.parse(await fs.readFile(manifestPath,'utf8'));restore.jobs.find(j=>j.id==='amazon-catalog-source').env.V3_AMAZON_LIVE_CONFIG=liveConfigPath;
 await keep(manifestPath+'.one-restore',restore);await fs.rename(manifestPath+'.one-restore',manifestPath);await restart('amazon-catalog-source');
 await idle();
 const passed=described.status.name==='COMPLETED'&&permits===0&&summary.captureVia?.mode==='http'&&receipts.every(r=>r==='registered')&&(summary.reusedFormula||collected>0)&&(enrichment.length>0||enrich.some(a=>a.enrichment?.status==='review'));
 console.log(JSON.stringify({event:'ONE_DONE',passed,dir}));
}finally{await db.end();await connection.close();}
