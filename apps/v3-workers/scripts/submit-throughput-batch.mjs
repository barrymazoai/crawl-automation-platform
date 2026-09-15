// N-product test after apply-throughput-rollout.mjs (fleet running). `--watch <dir>` resumes an already submitted run.
// N-product test: one Brand request carrying N ASINs (<=10, the
// same shape as one campaign chunk), then per-product evidence from Temporal history + ledger: ScraperAPI capture,
// OCR host/outcome/receipt, formula reuse, enrichment. Usage: node submit-throughput-batch.mjs <count|ASIN...>
import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {hostname} from 'node:os';import {randomUUID} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import pg from 'pg';import {Client,Connection} from '@temporalio/client';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',history='/Users/barry/apps/crawlv3-history-20260913',work=history+'/ocr-cloud-20260915',plan2000=history+'/amazon-2000-us-20260913/temporal-plan.json';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),keep=(p,v)=>fs.writeFile(p,typeof v==='string'?v:JSON.stringify(v,null,2),{flag:'wx',mode:0o600}),run=promisify(execFile),pause=ms=>new Promise(r=>setTimeout(r,ms));
const rollout=await read(work+'/rollout/receipt.json');assert.equal(rollout.passed,true);assert.equal(rollout.capture.mode,'scraperapi');
const manifestPath=main+'/live/deployment.json',text=await fs.readFile(manifestPath,'utf8'),m=JSON.parse(text);
const status=await read(main+'/status.json');assert.ok(status.jobs.every(j=>j.ready),'fleet not ready');assert.ok(Date.now()-Date.parse(status.at)<20000,'status stale');
// Every Amazon role resolves link batches from its own config copy (control checks the submission scope against them), so all seven are rebound for the test.
const amazonRoles=['amazon-control','amazon-catalog-source','amazon-catalog-ledger','amazon-product-input','amazon-capture','amazon-file','amazon-review'];
const source=m.jobs.find(j=>j.id==='amazon-catalog-source'),liveConfigPath=source.env.V3_AMAZON_LIVE_CONFIG,live=await read(liveConfigPath);for(const id of amazonRoles)assert.equal(m.jobs.find(j=>j.id===id).env.V3_AMAZON_LIVE_CONFIG,liveConfigPath,'Amazon roles must share one config: '+id);assert.equal(live.capture.mode,'scraperapi');assert.ok(live.productQueues.enrich);
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
 const watching=process.argv[2]==='--watch';if(!watching)await idle();
 const plan=await read(plan2000),attempted=new Set((await db.query("SELECT DISTINCT record->'entry'->>'listingId' asin FROM catalog_discovery WHERE record->'scope'->>'channel'='amazon'")).rows.map(r=>r.asin));
 const args=process.argv.slice(2),watch=args[0]==='--watch'?args[1]:null;let asins;
 const intent=watch?await read(watch+'/submit-intent.json'):null;
 if(intent)asins=intent.asins;else if(args.length===1&&/^\d+$/.test(args[0]))asins=plan.products.filter(p=>!attempted.has(p.asin)).slice(0,Number(args[0])).map(p=>p.asin);else asins=args;
 assert.ok(asins.length>=1&&asins.length<=10,'1..10 ASINs');for(const a of asins)assert.ok(plan.products.some(p=>p.asin===a),'ASIN not in plan: '+a);
 // One request must come from one scope; take the template batch of the first ASIN and require the rest to share its scope.
 const template=plan.batches.find(b=>b.entries.some(e=>e.entry.listingId===asins[0]));assert.ok(template);
 const entries=asins.map(a=>{const b=plan.batches.find(b=>b.entries.some(e=>e.entry.listingId===a));assert.deepEqual(b.scope,template.scope,'scope differs: '+a);return b.entries.find(e=>e.entry.listingId===a);});
 const requestId=intent?.requestId??randomUUID(),batch={...template,requestId,entries};
 const src=(await db.query('SELECT brand_id,channel,region,enabled FROM brand_source WHERE id=$1',[batch.scope.sourceId])).rows[0];assert.ok(src?.enabled);assert.equal(src.channel,'amazon');assert.equal(src.brand_id,batch.scope.brandId);
 const prior=intent?.prior??Object.fromEntries(await Promise.all(asins.map(async a=>[a,{formula:(await db.query("SELECT count(*)::int n FROM collected_product WHERE record->'observation'->>'listingId'=$1",[a])).rows[0].n,enrichment:(await db.query('SELECT count(*)::int n FROM product_enrichment WHERE listing_id=$1',[a])).rows[0].n}])));
 const dir=watch??work+'/batch-'+asins.length+'-'+requestId.slice(0,8);const canonical=liveConfigPath.startsWith(work+'/batch-')?JSON.parse(await fs.readFile(liveConfigPath.replace(/\/amazon\.private\.json$/,'/deployment-before.private.json'),'utf8')).jobs.find(j=>j.id==='amazon-catalog-source').env.V3_AMAZON_LIVE_CONFIG:liveConfigPath;assert.ok(!canonical.startsWith(work+'/batch-'),'canonical config must not be a test copy');
 if(!watch){await fs.mkdir(dir,{mode:0o700});await keep(dir+'/link-batch.json',batch);await keep(dir+'/amazon.private.json',{...live,linkBatches:[...(live.linkBatches??[]),batch]});}
 const controller=main+'/release-independent-control-20260913/independent-deployment/deployment-launchd.js';
 const next=structuredClone(m);for(const id of amazonRoles)next.jobs.find(j=>j.id===id).env.V3_AMAZON_LIVE_CONFIG=dir+'/amazon.private.json';
 if(!watch){await keep(dir+'/deployment-before.private.json',text);await keep(manifestPath+'.batch-next',next);await fs.rename(manifestPath+'.batch-next',manifestPath);}
 const restart=async id=>{const r=await run('/opt/homebrew/bin/node',[controller,'restart',manifestPath,id],{timeout:180000,maxBuffer:1048576});assert.equal(JSON.parse(r.stdout).ready[0].id,id);const h=await read(main+'/'+id+'.health.json');assert.equal(h.event,'WORKER_RUNNING');return h;};
 if(!watch)for(const id of amazonRoles)await restart(id);
 if(!watch)await keep(dir+'/submit-intent.json',{at:new Date().toISOString(),requestId,asins,brandId:batch.scope.brandId,sourceId:batch.scope.sourceId,prior});
 const submission=watch?{requestId,workflowId:'v3-collection-'+requestId}:await api('/brands/'+batch.scope.brandId+'/sources/'+batch.scope.sourceId+'/submissions','POST',{sourceRevision:Number(batch.scope.scopeVersion.replace('source-revision-',''))},requestId);
 assert.equal(submission.requestId,requestId);assert.equal(submission.workflowId,'v3-collection-'+requestId);if(!watch)await keep(dir+'/submission.json',submission);
 console.log(JSON.stringify({event:'BATCH_SUBMITTED',requestId,asins,workflowId:submission.workflowId}));
 const root=client.workflow.getHandle(submission.workflowId);const started=Date.now();let described,lastLine='';
 // Brand delivery is asynchronous: the root workflow appears after the delivery scan picks the intent up.
 for(;;){try{described=await root.describe();}catch(e){if(e?.name!=='WorkflowNotFoundError'||Date.now()-started>15*60000)throw e;await pause(10000);continue;}if(described.status.name!=='RUNNING')break;if(Date.now()-started>60*60000)throw Error('BATCH_TIMEOUT');
  const done=(await db.query("SELECT count(*)::int n FROM collected_product WHERE record->'observation'->>'requestId'=$1",[requestId])).rows[0].n,reviews=(await db.query("SELECT count(*)::int n FROM review_record WHERE record->'observation'->>'requestId'=$1",[requestId])).rows[0].n;
  const line=`collected ${done}/${asins.length} reviews ${reviews}`;if(line!==lastLine){console.log(JSON.stringify({event:'BATCH_PROGRESS',elapsedSeconds:Math.round((Date.now()-started)/1000),line}));lastLine=line;}await pause(20000);}
 console.log(JSON.stringify({event:'BATCH_ROOT_'+described.status.name,elapsedSeconds:Math.round((Date.now()-started)/1000)}));
 const discoveries=(await db.query('SELECT record FROM catalog_discovery WHERE catalog_id=$1',[requestId])).rows.map(r=>r.record);
 const decode=p=>JSON.parse(Buffer.from(p.data).toString());
 const inspectWorkflow=async id=>{const h=client.workflow.getHandle(id);let d;try{d=await h.describe();}catch{return{status:'NOT_STARTED',activities:[]};}
  const hist=await h.fetchHistory();const acts=new Map(),rows=[];let result=null;
  for(const e of hist.events){
   if(e.activityTaskScheduledEventAttributes)acts.set(String(e.eventId),{name:e.activityTaskScheduledEventAttributes.activityType.name});
   if(e.activityTaskStartedEventAttributes){const a=acts.get(String(e.activityTaskStartedEventAttributes.scheduledEventId));if(a)a.identity=e.activityTaskStartedEventAttributes.identity;}
   if(e.activityTaskCompletedEventAttributes){const a=acts.get(String(e.activityTaskCompletedEventAttributes.scheduledEventId));if(a){const p=e.activityTaskCompletedEventAttributes.result?.payloads?.[0];a.result=p?decode(p):null;rows.push(a);}}
   if(e.activityTaskFailedEventAttributes){const a=acts.get(String(e.activityTaskFailedEventAttributes.scheduledEventId));if(a){a.failed=e.activityTaskFailedEventAttributes.failure?.message?.slice(0,200);rows.push(a);}}
   if(e.workflowExecutionCompletedEventAttributes){const p=e.workflowExecutionCompletedEventAttributes.result?.payloads?.[0];result=p?decode(p):null;}
  }
  return{type:d.type,status:d.status.name,events:hist.events.length,result:result&&{status:result.status,reusedFormula:result.reusedFormula??false,code:result.code},
   activities:rows.map(a=>({name:a.name,host:a.identity?.split('/')[0],status:a.result?.status??(a.failed?'FAILED':'?'),
    ...(a.name==='captureAmazonProduct'?{fetchedVia:find(a.result,'fetchedVia')??null}:{}),...(a.name==='resolveOcrReceipt'?{receipt:a.result?.status}:{}),
    ...(a.name==='inspectExistingFormula'?{existing:a.result}:{}),...(a.name==='enrichProduct'?{enrichment:a.result&&{status:a.result.status,reused:a.result.reused,code:a.result.code}}:{}),...(a.failed?{failed:a.failed}:{})}))};};
 const products=[];
 for(const d of discoveries){const asin=d.entry.listingId,productId=d.workflowId,labelId=productId+'-label';const product=await inspectWorkflow(productId),label=await inspectWorkflow(labelId),all=[...product.activities,...label.activities];
  const capture=all.find(a=>a.name==='captureAmazonProduct'),ocr=all.filter(a=>a.name==='ocrFile'),receipts=all.filter(a=>a.name==='resolveOcrReceipt'),enrich=all.filter(a=>a.name==='enrichProduct');
  const enrichment=(await db.query('SELECT count(*)::int n FROM product_enrichment WHERE listing_id=$1',[asin])).rows[0].n;
  const reviews=(await db.query("SELECT record->'failure'->>'code' code,record->'failure'->>'stage' stage FROM review_record WHERE record->'observation'->>'listingId'=$1 AND record->'observation'->>'requestId'=$2",[asin,requestId])).rows;
  products.push({asin,productStatus:product.result?.status??product.status,reusedFormula:product.result?.reusedFormula??false,captureVia:capture?.fetchedVia?.mode??null,
   ocr:ocr.map(a=>a.host+':'+a.status),receipts:receipts.map(r=>r.receipt),text:all.filter(a=>a.name==='interpretText').map(a=>a.host+':'+a.status),vision:all.filter(a=>a.name==='interpretImage').map(a=>a.host+':'+a.status),
   enrich:enrich.map(a=>a.enrichment?.status+(a.enrichment?.reused?'(reused)':'')),enrichmentRows:{before:prior[asin]?.enrichment??0,after:enrichment},reviews,workflows:{[productId]:product,[labelId]:label}});}
 const permits=(await db.query('SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL')).rows[0].n;
 const collected=(await db.query("SELECT count(*)::int n FROM collected_product WHERE record->'observation'->>'requestId'=$1",[requestId])).rows[0].n;
 const summary={rootStatus:described.status.name,elapsedSeconds:Math.round((Date.now()-started)/1000),requested:asins.length,discovered:discoveries.length,collected,heldPermits:permits,
  products:products.map(({workflows:_w,...p})=>p)};
 await fs.writeFile(dir+'/evidence.json',JSON.stringify({requestId,summary,products},null,2),{mode:0o600});console.log('EVIDENCE '+JSON.stringify(summary,null,1));
 const restore=JSON.parse(await fs.readFile(manifestPath,'utf8'));for(const id of amazonRoles)restore.jobs.find(j=>j.id===id).env.V3_AMAZON_LIVE_CONFIG=canonical;
 await fs.writeFile(manifestPath+'.batch-restore',JSON.stringify(restore,null,2),{flag:'wx',mode:0o600});await fs.rename(manifestPath+'.batch-restore',manifestPath);for(const id of amazonRoles)await restart(id);
 await idle();
 const ok=products.filter(p=>(p.productStatus==='collected'||p.reusedFormula)&&p.captureVia==='http'&&p.receipts.every(r=>r==='registered')&&p.enrichmentRows.after>0).length;
 console.log(JSON.stringify({event:'BATCH_DONE',passed:described.status.name==='COMPLETED'&&permits===0&&ok===asins.length,ok,requested:asins.length,dir}));
}finally{await db.end();await connection.close();}
