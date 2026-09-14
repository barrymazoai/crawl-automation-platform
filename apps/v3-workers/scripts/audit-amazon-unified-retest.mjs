// Mini-only, read-only acceptance of settled products in the bounded retest.
// No recovery, task submission, provider calls, or browser-page mutation.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {hostname} from 'node:os';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {Client,Connection} from '@temporalio/client';
import {defaultPayloadConverter} from '@temporalio/common';

const [work,countArg]=process.argv.slice(2),expected=Number(countArg);
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);assert.ok([2,10].includes(expected));
const dir='/Users/barry/apps/crawlv3-history-20260913/amazon-unified-retest-10-20260914';
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const keep=(p,v)=>fs.writeFile(p,JSON.stringify(v,null,2),{flag:'wx',mode:0o600});
const sha=b=>createHash('sha256').update(b).digest('hex');
const lib=await import(work+'/candidate/acceptance/purchase-conditions-inspect.js');
const plan=await read(dir+'/temporal-plan.json'),r=await read(dir+'/control.runtime.json'),t=r.transport,c=await read(dir+'/amazon.private.json');
const ids=plan.batches.slice(0,expected/2).map(b=>b.requestId);assert.equal(plan.productCount,10);
const out=await fs.mkdtemp(dir+'/acceptance-'+expected+'-');
const connection=await Connection.connect({address:r.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
const db=new pg.Pool({connectionString:c.database.connectionString,max:1,statement_timeout:10000,options:'-c default_transaction_read_only=on'});
const decode=v=>v?.payloads?.length?defaultPayloadConverter.fromPayload(v.payloads[0]):null;
const ms=t=>t?Number(t.seconds)*1000+Number(t.nanos??0)/1e6:null;
const peak=spans=>{let n=0,max=0;for(const [,d] of spans.flatMap(s=>[[s.start,1],[s.end,-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1])){n+=d;max=Math.max(n,max);}return max;};
try{
 const client=new Client({connection,namespace:r.namespace}),campaign=client.workflow.getHandle(plan.campaignId),state=await campaign.describe();
 const progress=state.status.name==='COMPLETED'?await campaign.result():await campaign.query('progress');
 assert.equal(progress.cursor,expected/2);assert.equal(progress.phase,expected===2?'paused':'complete');
 const campaignHistory=await campaign.fetchHistory(),campaignEvents=campaignHistory.events??[];
 await keep(out+'/campaign-history.json',campaignHistory);
 const resumeEvent=campaignEvents.find(e=>e.workflowExecutionSignaledEventAttributes?.signalName==='runUntil'&&decode(e.workflowExecutionSignaledEventAttributes.input)===5);
 const pauseEnd=resumeEvent?ms(resumeEvent.eventTime):Date.now();
 const scheduledReports=new Set(campaignEvents.filter(e=>e.activityTaskScheduledEventAttributes?.activityType?.name==='reportAmazonHistoryBatch').map(e=>e.eventId.toString()));
 const lastReportBeforeResume=campaignEvents.filter(e=>e.activityTaskCompletedEventAttributes&&scheduledReports.has(e.activityTaskCompletedEventAttributes.scheduledEventId.toString())&&ms(e.eventTime)<pauseEnd).at(-1);
 assert.ok(lastReportBeforeResume);const acceptancePauseSeconds=(pauseEnd-ms(lastReportBeforeResume.eventTime))/1000;
 const old=await client.workflow.getHandle('amazon-history-100-us-10001-20260913').query('progress');assert.equal(old.phase,'paused');assert.equal(old.cursor,24);assert.equal(old.stopAfter,24);
 const discoveries=(await db.query('SELECT record FROM catalog_discovery WHERE catalog_id=ANY($1)',[ids])).rows.map(r=>r.record);assert.equal(discoveries.length,expected);
 const queue=ids.map(id=>'v3-collection-'+id),seen=new Set(),workflows=[],activities=[],pages=[],jobs=new Map(),closedCalls=new Map(),grants=new Map(),releases=new Map();
 while(queue.length){
  const id=queue.shift();if(seen.has(id))continue;seen.add(id);
  const h=client.workflow.getHandle(id),d=await h.describe(),history=await h.fetchHistory(),events=history.events??[];
  assert.equal(d.status.name,'COMPLETED',id);await keep(out+'/history-'+d.runId+'.json',history);
  workflows.push({id,runId:d.runId,type:d.type,status:d.status.name,start:ms(events[0]?.eventTime),end:ms(events.at(-1)?.eventTime),result:await h.result()});
  for(const e of events){const child=e.childWorkflowExecutionStartedEventAttributes?.workflowExecution?.workflowId;if(child)queue.push(child);}
  for(const e of events.filter(e=>e.activityTaskScheduledEventAttributes)){
   const a=e.activityTaskScheduledEventAttributes,key=e.eventId.toString();
   const started=events.find(x=>x.activityTaskStartedEventAttributes?.scheduledEventId?.toString()===key);
   const completed=events.find(x=>x.activityTaskCompletedEventAttributes?.scheduledEventId?.toString()===key);
   const failed=events.find(x=>x.activityTaskFailedEventAttributes?.scheduledEventId?.toString()===key);
   const input=decode(a.input),result=decode(completed?.activityTaskCompletedEventAttributes?.result);
   const end=completed??failed;
   activities.push({workflowId:id,name:a.activityType.name,scheduled:ms(e.eventTime),start:ms(started?.eventTime),end:ms(end?.eventTime),failed:!!failed});
   if(a.activityType.name==='prepareAmazonProduct'&&result?.codec==='amazon-product-job/1')jobs.set(result.sessionId,result);
   if(a.activityType.name==='closeAmazonProductPage'&&result?.status==='closed')closedCalls.set(result.taskId,result);
   if(a.activityType.name==='reserveResources'&&result?.status==='granted')grants.set(input.permitId,{request:input,start:ms(completed.eventTime)});
   if(a.activityType.name==='releaseResources'&&result?.status==='released')releases.set(input.permitId,ms(completed.eventTime));
  }
 }
 assert.equal(jobs.size,expected);assert.equal(closedCalls.size,expected);
 for(const [taskId] of jobs){
  const base=c.pageJournalRoot+'/v3/browser-pages/'+sha(Buffer.from(JSON.stringify([c.browser,taskId])));
  const bytes=await fs.readFile(base+'/closed.json'),closed=JSON.parse(bytes.toString());assert.deepEqual(closed,await read(base+'/opened.json'));assert.equal(closed.taskId,taskId);assert.equal(closed.targetId,closedCalls.get(taskId).targetId);
  pages.push({taskId,targetId:closed.targetId,closedPath:base+'/closed.json',sha256:sha(bytes)});
 }
 const checks=[];
 for(let n=0;n<3;n++){
  const select=c.browser.sdk==='1'?`await useOrCreateTaskSpace(${c.browser.taskSpaceId});const snapshot={tabs:await listTabs()};`:`const task=await taskSpace(${c.browser.taskSpaceId});const snapshot={tabs:await task.tabs()};`;
  const snapshot=await new lib.EgoCliRunner().run(c.browser.cliPath,select,AbortSignal.timeout(20000));
  assert.ok(pages.every(p=>snapshot.tabs.every(t=>t.targetId!==p.targetId)));
  checks.push({at:new Date().toISOString(),targetsAbsent:true});
 }
 const owners=[...seen],permits=(await db.query("SELECT permit_id,request,released_at FROM resource_permit WHERE request->>'workflowId'=ANY($1)",[owners])).rows;
 assert.ok(permits.every(p=>p.released_at!==null));assert.equal((await db.query('SELECT count(*)::int n FROM source_submission_guard WHERE request_id=ANY($1::uuid[])',[ids])).rows[0].n,0);
 const rows=(await db.query("SELECT source_record_id,record FROM product_history_source WHERE dataset='v3:amazon' AND (record->'owner'->>'requestId'=ANY($1) OR record->'collection'->'observation'->>'requestId'=ANY($1))",[ids])).rows;
 const captures=rows.filter(x=>x.record.codec==='v3-capture-history/1');assert.equal(captures.length,expected);
 const historyRecordsVerified=await new lib.ProductHistory(db).verify(rows.map(x=>lib.convertHistoryInput(x.record)));assert.equal(historyRecordsVerified,rows.length);
 const materials=[];
 for(const {record:v} of rows){
  const capture=v.codec==='v3-formula-history/1'?captures.find(x=>x.source_record_id===v.captureSourceId)?.record:undefined;
  const material=lib.productServiceMaterial(lib.convertHistoryInput(v),capture);materials.push(material);
  if(v.codec==='v3-capture-history/1'){
   assert.equal(material.metrics.length,1);const item=material.metrics[0].items[0];
   assert.equal(item.reviewCount,v.metrics.reviewCount===null?undefined:Number(v.metrics.reviewCount));assert.equal(item.inStock,v.metrics.inStock===null?undefined:v.metrics.inStock);
   assert.deepEqual(item.extras.purchaseConditions,v.metrics.extras.purchaseConditions);
  }
 }
 await keep(out+'/service-material.json',materials);
 const reviews=(await db.query("SELECT record->'observation'->>'listingId' asin,record->'failure'->>'stage' stage,record->'failure'->>'code' code FROM review_record WHERE record->'observation'->>'requestId'=ANY($1)",[ids])).rows;
 const spans=[...grants].map(([id,g])=>({id,...g,end:releases.get(id)})).filter(s=>s.end!==undefined),activitySpans=activities.filter(a=>a.start!==null&&a.end!==null);
 const resourcePeaks=Object.fromEntries(['mini-ego-space-1','mini-model-account','windows-ocr'].map(id=>[id,peak(spans.filter(s=>s.request.needs.some(n=>n.resourceId===id)))]));assert.ok(resourcePeaks['mini-ego-space-1']<=1);
 const modelSpans=activitySpans.filter(a=>['interpretImage','interpretText'].includes(a.name));
 const captureSpans=activitySpans.filter(a=>['captureAmazonProduct','acquireAmazonFile'].includes(a.name));
 const overlap=captureSpans.flatMap(a=>modelSpans.filter(b=>b.workflowId!==a.workflowId&&Math.max(a.start,b.start)<Math.min(a.end,b.end)).map(b=>({capture:a.workflowId,model:b.workflowId,seconds:(Math.min(a.end,b.end)-Math.max(a.start,b.start))/1000})));
 const previous=await read(work+'/evidence/records.json');
 for(const v of previous.captures){const current=(await db.query("SELECT record FROM product_history_source WHERE dataset='v3:amazon' AND record->>'observationId'=$1",[v.observationId])).rows;assert.equal(current.length,1);assert.deepEqual(current[0].record,v);}
 const workers=await read(main+'/status.json');assert.ok(workers.jobs.every(j=>j.ready));assert.ok(Date.now()-Date.parse(workers.at)<20000);
 const elapsed=(new Date(state.closeTime??Date.now()).getTime()-new Date(state.startTime).getTime())/1000;
 const report={at:new Date().toISOString(),verified:true,expected,campaignId:plan.campaignId,phase:progress.phase,cursor:progress.cursor,elapsedSeconds:elapsed,acceptancePauseSeconds,processingSeconds:elapsed-acceptancePauseSeconds,workflowCount:workflows.length,
  products:discoveries.map(d=>({asin:d.entry.listingId,result:workflows.find(w=>w.id===d.workflowId)?.result})),
  captures:captures.map(({record:v})=>({asin:v.listing.externalId,observationId:v.observationId,price:v.metrics.price,reviewCount:v.metrics.reviewCount,inStock:v.metrics.inStock,purchaseConditions:v.metrics.extras.purchaseConditions})),
  reviews,formulaMaterials:materials.reduce((n,m)=>n+m.labels.length,0),equivalentFootnotes:materials.flatMap(m=>m.labels.flatMap(l=>l.draft.label.content.exclusions.filter(e=>/equivalent/i.test(e.quote.text)))),
  pages,checks,held:0,historyRecordsVerified,oldCaptureRecordsPreserved:previous.captures.length,oldCampaignPausedAt:24,workersReady:workers.jobs.length,resourcePeaks,modelActivityPeak:peak(modelSpans),captureModelOverlap:overlap};
 await keep(out+'/timing.json',{workflows,activities,resourceSpans:spans});await keep(out+'/report.json',report);
 await keep(dir+'/acceptance-'+expected+'.json',{out,reportPath:out+'/report.json',verified:true});
 console.log(JSON.stringify({...report,captures:report.captures.map(c=>({asin:c.asin,price:c.price,reviewCount:c.reviewCount,inStock:c.inStock})),pages:pages.length,captureModelOverlap:overlap.length}));
}finally{await db.end();await connection.close();}
