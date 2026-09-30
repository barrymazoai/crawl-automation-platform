/** Read-only closeout of the exact five-product campaign; never closes live pages. */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {hostname} from 'node:os';
import pg from 'pg';
import {Client,Connection} from '@temporalio/client';
import {defaultPayloadConverter} from '@temporalio/common';
import {AmazonProductJobSchema} from '@crawl-automation/v3-contracts';
import {EgoCliRunner} from '@crawl-automation/v3-acquisition';
import {sha256} from '@crawl-automation/v3-artifacts';
const root='/Users/barry/apps/crawlv3-batch-a.UiA4dx',dir='/Users/barry/apps/crawlv3-history-20260913/amazon-5-us-20260913',read=async(p:string)=>JSON.parse(await fs.readFile(p,'utf8'));
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const plan=await read(dir+'/temporal-plan.json'),m=await read(root+'/live/deployment.json'),c=await read(m.jobs.find((j:any)=>j.id==='amazon-capture').env.V3_AMAZON_LIVE_CONFIG),r=await read(m.jobs.find((j:any)=>j.id==='amazon-brand-workflow').env.V3_WORKER_CONFIG),t=r.transport;
const connection=await Connection.connect({address:r.address,tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}}),db=new pg.Pool({connectionString:c.database.connectionString,max:1});
try{
 const client=new Client({connection,namespace:r.namespace}),campaign=client.workflow.getHandle(plan.campaignId);assert.equal((await campaign.describe()).status.name,'COMPLETED');const result=await campaign.result() as any;assert.equal(result.totalProducts,5);assert.equal(result.cursor,5);assert.equal(result.phase,'complete');
 const ids=plan.batches.map((b:any)=>b.requestId),discoveries=(await db.query('select record from catalog_discovery where catalog_id=ANY($1)',[ids])).rows.map(x=>x.record);assert.equal(discoveries.length,5);assert.deepEqual(discoveries.map(x=>x.entry.listingId).sort(),plan.products.map((p:any)=>p.asin).sort());
 const pages=[],products=[];
 for(const d of discoveries){
  const handle=client.workflow.getHandle(d.workflowId),state=await handle.describe();assert.equal(state.status.name,'COMPLETED');assert.equal(state.raw.pendingActivities?.length??0,0);
  const history=await handle.fetchHistory(),events=history.events??[];
  const completed=(name:string)=>events.filter(e=>e.activityTaskScheduledEventAttributes?.activityType?.name===name).flatMap(e=>{const end=events.find(x=>x.activityTaskCompletedEventAttributes?.scheduledEventId?.toString()===e.eventId?.toString());return end?[defaultPayloadConverter.fromPayload(end.activityTaskCompletedEventAttributes!.result!.payloads![0]!) as any]:[];});
  const prepared=completed('prepareAmazonProduct');assert.equal(prepared.length,1);const job=AmazonProductJobSchema.parse(prepared[0]);assert.equal(job.discovery.discoveryId,d.discoveryId);
  const close=completed('closeAmazonProductPage');assert.equal(close.length,1);assert.equal(close[0].status,'closed');assert.equal(close[0].taskId,job.sessionId);
  const path=c.pageJournalRoot+'/v3/browser-pages/'+sha256(Buffer.from(JSON.stringify([c.browser,job.sessionId]))),opened=await read(path+'/opened.json'),closed=await read(path+'/closed.json');assert.deepEqual(closed,opened);assert.equal(closed.taskId,job.sessionId);assert.equal(closed.targetId,close[0].targetId);
  pages.push({asin:d.entry.listingId,taskId:job.sessionId,targetId:closed.targetId,closedSha256:sha256(await fs.readFile(path+'/closed.json'))});
  const outcome=await handle.result() as any;products.push({asin:d.entry.listingId,workflowId:d.workflowId,status:outcome.status,code:outcome.code??null,reviewId:outcome.reviewId??null});
  for(const e of events.filter(e=>e.childWorkflowExecutionStartedEventAttributes)){const child=e.childWorkflowExecutionStartedEventAttributes!.workflowExecution!,s=await client.workflow.getHandle(child.workflowId!,child.runId!).describe();assert.equal(s.status.name,'COMPLETED');assert.equal(s.raw.pendingActivities?.length??0,0);}
 }
 const owners=discoveries.flatMap(d=>[d.workflowId,d.workflowId+'-label']);assert.equal((await db.query("select count(*)::int n from resource_permit where released_at is null and request->>'workflowId'=ANY($1)",[owners])).rows[0].n,0);
 assert.equal((await db.query('select count(*)::int n from source_submission_guard where request_id=ANY($1::uuid[])',[ids])).rows[0].n,0);
 const checks=[];for(let n=0;n<3;n++){const snapshot:any=await new EgoCliRunner().run(c.browser.cliPath,'await useOrCreateTaskSpace(1);const snapshot={tabs:await listTabs()};',AbortSignal.timeout(15000));assert.ok(pages.every(p=>snapshot.tabs.every((t:any)=>t.targetId!==p.targetId)));checks.push({at:new Date().toISOString(),targetsAbsent:true});}
 const captures=(await db.query("select source_record_id,record from product_history_source where dataset='v3:amazon' and record->>'codec'='v3-capture-history/1' and record->'owner'->>'requestId'=ANY($1)",[ids])).rows;
 assert.ok(captures.length<=5);assert.equal(new Set(captures.map(x=>x.record.listing.externalId)).size,captures.length);
 const trend=(await db.query("select s.record->'listing'->>'externalId' asin,o.kind,o.observed_at,o.record from product_history_source s join product_history_observation_source x using(source_record_id) join product_history_observation o using(observation_id) where s.source_record_id=ANY($1) order by asin,o.kind",[captures.map(x=>x.source_record_id)])).rows;
 const summaries=(await db.query("select record->'observation'->>'listingId' asin,record->'failure'->>'code' code,review_id from review_record where record->'observation'->>'requestId'=ANY($1)",[ids])).rows;
 const prices=(await read(dir+'/temporal-prices.json')).map(({newContext,...p}:any)=>p);
 const report={at:new Date().toISOString(),campaignId:plan.campaignId,report:result.report,products,reviews:summaries,prices,pages,checks,heldPermits:0,intakeGuards:0,trendRows:trend.map(x=>({asin:x.asin,kind:x.kind,observedAt:x.observed_at,price:x.record.price??null,currency:x.record.currency??null}))};
 await fs.writeFile(dir+'/closeout.json',JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});console.log(JSON.stringify({...report,report:{...result.report,priceChangeExamples:prices.filter((p:any)=>p.difference!==null&&p.difference!==0)}}));
}finally{await db.end();await connection.close();}
