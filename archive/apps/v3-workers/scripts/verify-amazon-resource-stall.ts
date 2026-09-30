/** Read-only acceptance of the first new product after recovery, on Mini only. */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {hostname} from 'node:os';
import pg from 'pg';
import {Client,Connection} from '@temporalio/client';
import {defaultPayloadConverter} from '@temporalio/common';
import {AmazonProductJobSchema} from '@crawl-automation/v3-contracts';
import {EgoCliRunner} from '@crawl-automation/v3-acquisition';
import {createR2Objects,sha256} from '@crawl-automation/v3-artifacts';
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',base='/Users/barry/apps/crawlv3-history-20260913',dir=base+'/amazon-resource-stall-fix-20260914',read=async(p:string)=>JSON.parse(await fs.readFile(p,'utf8'));
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const plan=await read(base+'/amazon-100-us-20260913/temporal-plan.json'),batch=plan.batches[10];assert.equal(batch.entries.length,1);assert.equal(batch.entries[0].entry.listingId,'B08LP471TS');
const m=await read(main+'/live/deployment.json'),c=await read(m.jobs.find((j:any)=>j.id==='amazon-capture').env.V3_AMAZON_LIVE_CONFIG),r=await read(m.jobs.find((j:any)=>j.id==='amazon-brand-workflow').env.V3_WORKER_CONFIG),t=r.transport;
const connection=await Connection.connect({address:r.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}}),db=new pg.Pool({connectionString:c.database.connectionString,max:1,statement_timeout:5000}),remote=createR2Objects(c.r2,c.r2Credentials);
try{
 const client=new Client({connection,namespace:r.namespace}),progress:any=await client.workflow.getHandle(plan.campaignId).query('progress');
 if(progress.cursor<11){console.log(JSON.stringify({status:'running',at:new Date().toISOString(),cursor:progress.cursor,phase:progress.phase}));}
 else{
  const rows=(await db.query('select record from catalog_discovery where catalog_id=$1',[batch.requestId])).rows;assert.equal(rows.length,1);const d=rows[0].record,h=client.workflow.getHandle(d.workflowId),state=await h.describe();assert.equal(state.status.name,'COMPLETED');
  const events=(await h.fetchHistory()).events??[],decode=(v:any)=>defaultPayloadConverter.fromPayload(v.payloads[0]) as any;
  const completed=(es:any[],name:string)=>es.filter(e=>e.activityTaskScheduledEventAttributes?.activityType?.name===name).flatMap(e=>{const end=es.find(x=>x.activityTaskCompletedEventAttributes?.scheduledEventId?.toString()===e.eventId?.toString());return end?[{input:decode(e.activityTaskScheduledEventAttributes.input),output:decode(end.activityTaskCompletedEventAttributes.result)}]:[];});
  const jobs=completed(events,'prepareAmazonProduct');assert.equal(jobs.length,1);const job=AmazonProductJobSchema.parse(jobs[0]!.output),close=completed(events,'closeAmazonProductPage');assert.equal(close.length,1);assert.equal(close[0]!.output.status,'closed');assert.equal(close[0]!.output.taskId,job.sessionId);
  const path=c.pageJournalRoot+'/v3/browser-pages/'+sha256(Buffer.from(JSON.stringify([c.browser,job.sessionId]))),closedBytes=await fs.readFile(path+'/closed.json'),closed=JSON.parse(closedBytes.toString());assert.deepEqual(closed,await read(path+'/opened.json'));assert.equal(closed.targetId,close[0]!.output.targetId);assert.equal(closed.taskId,job.sessionId);
  const checks=[];for(let i=0;i<3;i++){const snapshot:any=await new EgoCliRunner().run(c.browser.cliPath,'await useOrCreateTaskSpace(1);const snapshot={tabs:await listTabs()};',AbortSignal.timeout(15000));assert.ok(snapshot.tabs.every((tab:any)=>tab.targetId!==closed.targetId));checks.push({at:new Date().toISOString(),targetsAbsent:true});}
  const refs=events.filter(e=>e.childWorkflowExecutionStartedEventAttributes);assert.equal(refs.length,1);const child=refs[0]!.childWorkflowExecutionStartedEventAttributes!.workflowExecution!,ch=client.workflow.getHandle(child.workflowId!,child.runId!),cs=await ch.describe();assert.equal(cs.status.name,'COMPLETED');
  const ce=(await ch.fetchHistory()).events??[],patches=ce.filter(e=>e.markerRecordedEventAttributes?.markerName==='core_patch').map(e=>e.markerRecordedEventAttributes?.details);
  const stops=[];for(const stop of completed(ce,'verifyResourceReviewStopped')){assert.equal(stop.output.status,'stopped');const key=stop.output.evidenceKey;assert.equal(key,`v3/resource-stop/${stop.input.request.permitId}.json`);const bytes=await remote.store.read(key,65536,AbortSignal.timeout(15000));assert.ok(bytes);const proof=JSON.parse(Buffer.from(bytes).toString());assert.deepEqual(proof.request,stop.input.request);assert.equal(proof.codec,'owned-model-review-stop/1');stops.push({permitId:proof.request.permitId,evidenceKey:key,sha256:sha256(bytes)});}
  const held=(await db.query("select count(*)::int n from resource_permit where released_at is null and request->>'workflowId'=ANY($1)",[[d.workflowId,child.workflowId]])).rows[0].n;assert.equal(held,0);
  assert.equal((await client.workflow.getHandle('v3-collection-'+batch.requestId).describe()).status.name,'COMPLETED');
  assert.equal((await db.query('select count(*)::int n from source_submission_guard where request_id=$1',[batch.requestId])).rows[0].n,0);
  const captures=(await db.query("select source_record_id,record from product_history_source where dataset='v3:amazon' and record->>'codec'='v3-capture-history/1' and record->'owner'->>'requestId'=$1",[batch.requestId])).rows;
  const trend=captures.length?(await db.query("select o.kind,o.observed_at,o.record from product_history_observation_source s join product_history_observation o using(observation_id) where s.source_record_id=ANY($1)",[captures.map(x=>x.source_record_id)])).rows:[];
  const reviews=(await db.query("select review_id,record->'failure'->>'code' code from review_record where record->'observation'->>'requestId'=$1",[batch.requestId])).rows;
  const report={status:'verified',at:new Date().toISOString(),asin:d.entry.listingId,requestId:batch.requestId,workflowId:d.workflowId,productStatus:state.status.name,outcome:await h.result(),childStatus:cs.status.name,childEvents:ce.length,patchMarkers:patches.length,stops,heldPermits:0,intakeGuards:0,
   page:{taskId:job.sessionId,targetId:closed.targetId,closedSha256:sha256(closedBytes),checks},reviews,captures:captures.length,trendRows:trend.map(x=>({kind:x.kind,observedAt:x.observed_at,price:x.record.price??null,currency:x.record.currency??null})),cursor:progress.cursor};
  await fs.writeFile(dir+'/new-product-acceptance.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
 }
}finally{await db.end();await connection.close();remote.close();}
