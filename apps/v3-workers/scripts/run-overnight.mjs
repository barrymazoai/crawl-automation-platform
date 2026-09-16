// Mini, fleet RUNNING, unattended: crawl N never-attempted ASINs of the 2000 plan as Brand requests of `perRequest`
// products, grouped by source scope. Requests are submitted concurrently (a few seconds apart); the Amazon channel no
// longer serializes requests per source, and the product workflow skips listings attempted within 24 hours.
// The seven Amazon roles are bound ONCE to a config carrying every batch and restored at the end only when no root
// of this run is still running. While waiting, permits still held by CLOSED workflows are released with evidence
// (nothing can run under them), so a lost heartbeat cannot stall settlement. Progress: overnight-<ts>.log / .json.
//   nohup node run-overnight.mjs <total> [perRequest=10] [maxConcurrentRequests=8] > /dev/null 2>&1 &
//   node run-overnight.mjs retry-capture <since-iso> [perRequest] [maxConcurrent]   # re-crawl listings whose last outcome was a capture/preparation Review
import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {hostname} from 'node:os';import {randomUUID} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import pg from 'pg';import {Client,Connection} from '@temporalio/client';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const retryMode=process.argv[2]==='retry-capture',retrySince=retryMode?process.argv[3]:null,total=retryMode?2000:Number(process.argv[2]),perRequest=Number(process.argv[retryMode?4:3]??10),maxConcurrent=Number(process.argv[retryMode?5:4]??8);assert.ok(total>=1&&total<=2000&&perRequest>=1&&perRequest<=10&&maxConcurrent>=1&&maxConcurrent<=20);if(retryMode)assert.match(retrySince??'',/^\d{4}-\d{2}-\d{2}T/,'retry-capture needs an ISO start time');
// RETRY_CODES=A,B overrides the capture list, e.g. to rerun products a since-relaxed content rule had sent to Review.
const CAPTURE_REVIEW_CODES=process.env.RETRY_CODES?process.env.RETRY_CODES.split(','):['AMAZON.BROWSER_PHASE_UNRESOLVED','AMAZON.FILE_PUBLICATION_UNRESOLVED','CHANNEL.LABEL_PREPARATION_UNVERIFIED','CHANNEL.DEPENDENCY_UNAVAILABLE','ARTIFACT.UNAVAILABLE','ARTIFACT.UPLOAD_UNKNOWN'];
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',history='/Users/barry/apps/crawlv3-history-20260913',work=history+'/ocr-cloud-20260915',plan2000=history+'/amazon-2000-us-20260913/temporal-plan.json';
const stamp=new Date().toISOString().replace(/[:.]/g,'-'),dir=work+'/overnight-'+stamp,logPath=work+'/overnight-'+stamp+'.log';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),keep=(p,v)=>fs.writeFile(p,typeof v==='string'?v:JSON.stringify(v,null,2),{flag:'wx',mode:0o600}),run=promisify(execFile),pause=ms=>new Promise(r=>setTimeout(r,ms));
const log=async(event,extra={})=>{const line=JSON.stringify({at:new Date().toISOString(),event,...extra});await fs.appendFile(logPath,line+'\n',{mode:0o600});console.log(line);};
const amazonRoles=['amazon-control','amazon-catalog-source','amazon-catalog-ledger','amazon-product-input','amazon-capture','amazon-file','amazon-review'];
const manifestPath=main+'/live/deployment.json',text=await fs.readFile(manifestPath,'utf8'),m=JSON.parse(text);
const waitReady=async()=>{for(let w=0;w<36;w++){const st=await read(main+'/status.json');if(st.jobs.every(j=>j.ready)&&Date.now()-Date.parse(st.at)<20000)return true;await pause(5000);}return false;};
assert.ok(await waitReady(),'fleet not ready');
const source=m.jobs.find(j=>j.id==='amazon-catalog-source'),liveConfigPath=source.env.V3_AMAZON_LIVE_CONFIG;assert.ok(!liveConfigPath.includes('/batch-')&&!liveConfigPath.includes('/overnight-'),'Amazon roles bound to a test copy: '+liveConfigPath);
const live=await read(liveConfigPath);assert.equal(live.capture.mode,'scraperapi');assert.ok(live.productQueues.enrich);
const rt=await read(source.env.V3_WORKER_CONFIG),t=rt.transport;
const labelPrivate=await read(m.jobs.find(j=>j.id==='amazon-channel-label-ocr-receipts').env.V3_CHANNEL_LABEL_CONFIG);
const connection=await Connection.connect({address:rt.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
const db=new pg.Pool({connectionString:labelPrivate.database.connectionString,max:2,statement_timeout:10000});
const q=(sql,params)=>db.query(sql,params);
const api=async(p,method='GET',body,key)=>{const r=await fetch('http://127.0.0.1:4188/api/v3'+p,{method,signal:AbortSignal.timeout(15000),headers:{'X-V3-Client':'local-workspace',...(method!=='GET'?{Origin:'http://127.0.0.1:4188','Content-Type':'application/json','Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw Error('API_'+r.status+' '+(await r.text()).slice(0,200));return r.json();};
const controller=main+'/release-independent-control-20260913/independent-deployment/deployment-launchd.js';
const restart=async id=>{const r=await run('/opt/homebrew/bin/node',[controller,'restart',manifestPath,id],{timeout:180000,maxBuffer:1048576});assert.equal(JSON.parse(r.stdout).ready[0].id,id);const h=await read(main+'/'+id+'.health.json');assert.equal(h.event,'WORKER_RUNNING');};
const bind=async configPath=>{const cur=JSON.parse(await fs.readFile(manifestPath,'utf8'));for(const id of amazonRoles)cur.jobs.find(j=>j.id===id).env.V3_AMAZON_LIVE_CONFIG=configPath;const tmp=manifestPath+'.overnight-'+randomUUID().slice(0,8);await fs.writeFile(tmp,JSON.stringify(cur,null,2),{flag:'wx',mode:0o600});await fs.rename(tmp,manifestPath);for(const id of amazonRoles)await restart(id);};
const summary={startedAt:new Date().toISOString(),total,perRequest,maxConcurrent,requests:[],collected:0,reviews:0,skipped:0,enriched:0,permitsReleased:0,stoppedReason:null};
const client=new Client({connection,namespace:rt.namespace});
// Permits held by workflows that have already closed can never be used again; release them with retained evidence.
const releaseStalePermits=async()=>{const held=(await q("SELECT p.permit_id,p.request,p.granted_at,array_agg(n.resource_id) resources FROM resource_permit p JOIN resource_permit_need n USING(permit_id) WHERE p.released_at IS NULL GROUP BY 1,2,3")).rows;let n=0;
 for(const row of held){const {workflowId,runId}=row.request;let d;try{d=await client.workflow.getHandle(workflowId,runId).describe();}catch{continue;}if(d.status.name==='RUNNING')continue;
  const hist=await client.workflow.getHandle(workflowId,runId).fetchHistory();const open=hist.events.filter(e=>e.activityTaskScheduledEventAttributes).length-hist.events.filter(e=>e.activityTaskCompletedEventAttributes||e.activityTaskFailedEventAttributes||e.activityTaskTimedOutEventAttributes||e.activityTaskCanceledEventAttributes).length;const closedAgo=d.closeTime?Date.now()-new Date(d.closeTime).getTime():0;if(open!==0&&closedAgo<120000)continue;
  const r=await q('UPDATE resource_permit SET released_at=coalesce(released_at,now()) WHERE permit_id=$1 AND released_at IS NULL RETURNING released_at',[row.permit_id]);if(!r.rowCount)continue;
  await fs.mkdir(work+'/rollout/permit-releases',{recursive:true,mode:0o700});await fs.writeFile(work+'/rollout/permit-releases/'+row.permit_id+'.json',JSON.stringify({codec:'stale-permit-release/1',permitId:row.permit_id,resources:row.resources,request:row.request,grantedAt:row.granted_at,workflowType:d.type,workflowStatus:d.status.name,closeTime:d.closeTime,releasedAt:r.rows[0].released_at,reason:'workflow closed with every activity ended; released by run-overnight'},null,2),{flag:'wx',mode:0o600}).catch(()=>{});
  n++;await log('STALE_PERMIT_RELEASED',{permitId:row.permit_id,resources:row.resources,workflowId,status:d.status.name});}
 summary.permitsReleased+=n;return n;};
try{
 for await(const s of client.workflow.list({query:"ExecutionStatus = 'Running'"}))assert.ok(['AmazonHistoryBatchWorkflow','DtcNodeSessionWorkflow'].includes(s.type),'running '+s.type+' '+s.workflowId);
 const plan=await read(plan2000),attempted=new Set((await q("SELECT DISTINCT record->'entry'->>'listingId' asin FROM catalog_discovery WHERE record->'scope'->>'channel'='amazon'")).rows.map(r=>r.asin));
 let asins;
 if(retryMode){const rows=(await q("SELECT DISTINCT record->'observation'->>'listingId' asin FROM review_record WHERE registered_at>$1 AND record->'failure'->>'code'=ANY($2) AND record->'observation'->>'listingId' NOT IN (SELECT record->'observation'->>'listingId' FROM collected_product WHERE collected_at>$1)",[retrySince,CAPTURE_REVIEW_CODES])).rows;asins=rows.map(r=>r.asin).filter(a=>plan.products.some(p=>p.asin===a)).slice(0,total);}
 else asins=plan.products.filter(p=>!attempted.has(p.asin)).slice(0,total).map(p=>p.asin);
 assert.ok(asins.length>=1,'nothing left to attempt');await log('OVERNIGHT_SELECTION',{mode:retryMode?'retry-capture':'never-attempted',asins:asins.length});
 const byScope=new Map();for(const a of asins){const b=plan.batches.find(b=>b.entries.some(e=>e.entry.listingId===a));const k=JSON.stringify(b.scope);if(!byScope.has(k))byScope.set(k,{template:b,entries:[]});byScope.get(k).entries.push(b.entries.find(e=>e.entry.listingId===a));}
 const batches=[];for(const {template,entries} of byScope.values()){const src=(await q('SELECT brand_id,channel,region,enabled FROM brand_source WHERE id=$1',[template.scope.sourceId])).rows[0];assert.ok(src?.enabled&&src.channel==='amazon'&&src.brand_id===template.scope.brandId,'source not enabled: '+template.scope.sourceId);
  for(let i=0;i<entries.length;i+=perRequest)batches.push({...template,requestId:randomUUID(),entries:entries.slice(i,i+perRequest)});}
 await fs.mkdir(dir,{mode:0o700});await keep(dir+'/batches.json',batches);await keep(dir+'/amazon.private.json',{...live,linkBatches:[...(live.linkBatches??[]),...batches]});await keep(dir+'/deployment-before.private.json',text);
 await bind(dir+'/amazon.private.json');assert.ok(await waitReady(),'fleet not ready after bind');await log('OVERNIGHT_BOUND',{asins:asins.length,requests:batches.length,perRequest,maxConcurrent});
 const active=new Map();let next=0;
 const submit=async batch=>{const rid=batch.requestId;const submission=await api('/brands/'+batch.scope.brandId+'/sources/'+batch.scope.sourceId+'/submissions','POST',{sourceRevision:Number(batch.scope.scopeVersion.replace('source-revision-',''))},rid);
  assert.equal(submission.workflowId,'v3-collection-'+rid);active.set(rid,{batch,started:Date.now(),n:next});await log('REQUEST_SUBMITTED',{n:next,of:batches.length,requestId:rid,asins:batch.entries.map(e=>e.entry.listingId)});};
 const finish=async(rid,status)=>{const {batch,started,n}=active.get(rid);active.delete(rid);
  const collected=(await q("SELECT count(*)::int n FROM collected_product WHERE record->'observation'->>'requestId'=$1",[rid])).rows[0].n,reviews=(await q("SELECT count(*)::int n FROM review_record WHERE record->'observation'->>'requestId'=$1",[rid])).rows[0].n;
  const enriched=(await q("SELECT count(*)::int n FROM product_enrichment WHERE collection_operation_id IN (SELECT operation_id FROM collected_product WHERE record->'observation'->>'requestId'=$1)",[rid])).rows[0].n;
  const skipped=batch.entries.length-collected-reviews;const rec={n,requestId:rid,status,seconds:Math.round((Date.now()-started)/1000),products:batch.entries.length,collected,reviews,skipped:Math.max(0,skipped),enriched};
  summary.requests.push(rec);summary.collected+=collected;summary.reviews+=reviews;summary.skipped+=rec.skipped;summary.enriched+=enriched;await log('REQUEST_DONE',rec);await fs.writeFile(dir+'/summary.json',JSON.stringify(summary,null,2),{mode:0o600});};
 let lastSweep=Date.now();
 while(next<batches.length||active.size){
  while(next<batches.length&&active.size<maxConcurrent){try{await submit(batches[next]);}catch(e){await log('SUBMIT_FAILED',{n:next,message:String(e.message).slice(0,200)});}next++;await pause(3000);}
  await pause(20000);
  for(const [rid,{started}] of [...active.entries()]){let d;try{d=await client.workflow.getHandle('v3-collection-'+rid).describe();}catch(e){if(e?.name==='WorkflowNotFoundError'&&Date.now()-started<15*60000)continue;await log('REQUEST_LOST',{requestId:rid,message:String(e?.message).slice(0,120)});await finish(rid,'LOST');continue;}
   if(d.status.name!=='RUNNING')await finish(rid,d.status.name);else if(Date.now()-started>3*3600000){await log('REQUEST_ABANDONED',{requestId:rid,hours:3});await finish(rid,'ABANDONED');}}
  if(Date.now()-lastSweep>5*60000){lastSweep=Date.now();try{await releaseStalePermits();}catch(e){await log('SWEEP_FAILED',{message:String(e?.message).slice(0,160)});}}
 }
}catch(error){summary.stoppedReason='error: '+String(error?.message??error).slice(0,300);await log('OVERNIGHT_ERROR',{message:summary.stoppedReason});}
finally{
 let running=0;try{for await(const s of client.workflow.list({query:"WorkflowType = 'BrandCollectionWorkflow' AND ExecutionStatus = 'Running'"}))running++;}catch{}
 if(running===0){try{await bind(liveConfigPath);await log('OVERNIGHT_RESTORED');}catch(e){await log('OVERNIGHT_RESTORE_FAILED',{message:String(e?.message).slice(0,200)});}}
 else await log('OVERNIGHT_RESTORE_SKIPPED',{reason:'brand collections still running; Amazon roles stay bound to '+dir});
 summary.finishedAt=new Date().toISOString();await fs.writeFile(dir+'/summary.json',JSON.stringify(summary,null,2),{mode:0o600}).catch(()=>{});
 await log('OVERNIGHT_DONE',{collected:summary.collected,reviews:summary.reviews,skipped:summary.skipped,enriched:summary.enriched,requests:summary.requests.length,permitsReleased:summary.permitsReleased,stoppedReason:summary.stoppedReason});
 await db.end();await connection.close();
}
