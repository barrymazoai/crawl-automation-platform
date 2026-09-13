import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import pg from 'pg';
import {Client,Connection} from '@temporalio/client';
import {defaultPayloadConverter} from '@temporalio/common';
import {EgoCliRunner} from '@crawl-automation/v3-acquisition';
import {createR2Objects,sha256} from '@crawl-automation/v3-artifacts';
import {AmazonProductJobSchema} from '@crawl-automation/v3-contracts';
import {PostgresResourceAdmission} from '../../../packages/v3-product/src/resource-admission.js';
const dir='/Users/barry/apps/crawlv3-history-20260913/amazon-2000-us-20260913',root='/Users/barry/apps/crawlv3-batch-a.UiA4dx';
const read=async(p:string)=>JSON.parse(await fs.readFile(p,'utf8')),encode=(v:unknown)=>Buffer.from(JSON.stringify(v));
const mode=process.argv[2];assert.ok(mode==='--audit'||mode==='--release');
const m=await read(root+'/live/deployment.json'),c=await read(m.jobs.find((j:any)=>j.id==='amazon-capture').env.V3_AMAZON_LIVE_CONFIG),r=await read(m.jobs.find((j:any)=>j.id==='amazon-brand-workflow').env.V3_WORKER_CONFIG),t=r.transport;
const connection=await Connection.connect({address:r.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
const db=new pg.Pool({connectionString:c.database.connectionString,max:1,connectionTimeoutMillis:5000,statement_timeout:5000}),remote=createR2Objects(c.r2,c.r2Credentials);
try{
 const client=new Client({connection,namespace:r.namespace}),batchIds=c.linkBatches.map((b:any)=>b.requestId);
 const permits=(await db.query('select permit_id,request from resource_permit where released_at is null')).rows;
 const browserPermits=permits.filter(p=>p.request.needs.some((n:any)=>n.resourceId===c.browserResource));
 assert.equal(browserPermits.length,1,'exact single held browser permit required');const p=browserPermits[0];if(process.argv[3])assert.equal(p.permit_id,process.argv[3],'expected permit identity');
 assert.deepEqual(p.request.needs,[{units:1,resourceId:'mini-ego-space-1'}]);
 const h=client.workflow.getHandle(p.request.workflowId,p.request.runId),d=await h.describe(),history=await h.fetchHistory();
 assert.equal(d.runId,p.request.runId);assert.equal(d.type,'AmazonCatalogProductWorkflow');assert.ok(['COMPLETED','FAILED'].includes(d.status.name));assert.equal(d.raw.pendingActivities?.length??0,0);
 const events=history.events??[],completed=(name:string)=>{
  const scheduled=events.filter(e=>e.activityTaskScheduledEventAttributes?.activityType?.name===name);
  return scheduled.flatMap(e=>{const done=events.find(x=>x.activityTaskCompletedEventAttributes?.scheduledEventId?.toString()===e.eventId?.toString());
   if(!done)return[];const payloads=done.activityTaskCompletedEventAttributes!.result!.payloads!;assert.equal(payloads.length,1);return[defaultPayloadConverter.fromPayload(payloads[0]!) as any];});
 };
 const prepared=completed('prepareAmazonProduct');assert.equal(prepared.length,1);const job=AmazonProductJobSchema.parse(prepared[0]);
 assert.equal(job.discovery.workflowId,p.request.workflowId);assert.ok(batchIds.includes(job.discovery.catalogId));
 const jobBytes=await remote.store.read('v3/amazon-jobs/'+job.discovery.discoveryId+'.json',65536,AbortSignal.timeout(15000));assert.ok(jobBytes);assert.deepEqual(JSON.parse(Buffer.from(jobBytes!).toString()),job);
 const discovery=(await db.query('select record from catalog_discovery where discovery_id=$1',[job.discovery.discoveryId])).rows[0];assert.deepEqual(discovery.record,job.discovery);
 // A failed child may be accepted only if it failed in pure plan loading, before
 // any browser, file, OCR or model operation. Completed children need no held permits.
 const childHistories:any[]=[],children:any[]=[];
 for(const e of events.filter(e=>e.childWorkflowExecutionStartedEventAttributes)){
  const execution=e.childWorkflowExecutionStartedEventAttributes!.workflowExecution!;
  assert.equal(execution.workflowId,job.discovery.workflowId+'-label');
  const handle=client.workflow.getHandle(execution.workflowId!,execution.runId!),state=await handle.describe(),past=await handle.fetchHistory();
  assert.equal(state.runId,execution.runId);assert.equal(state.type,'ChannelStreamingLabelWorkflow');assert.equal(state.raw.pendingActivities?.length??0,0);
  assert.ok(['COMPLETED','FAILED'].includes(state.status.name));
  if(state.status.name==='FAILED'){
   const scheduled=past.events?.filter(e=>e.activityTaskScheduledEventAttributes)??[];
   assert.equal(scheduled.length,1);assert.equal(scheduled[0]!.activityTaskScheduledEventAttributes!.activityType!.name,'loadChannelLabelPlan');
   assert.equal(past.events?.filter(e=>e.childWorkflowExecutionStartedEventAttributes).length,0);
  }
  assert.equal((await db.query("select count(*)::int n from resource_permit where released_at is null and request->>'workflowId'=$1",[execution.workflowId])).rows[0].n,0);
  children.push({workflowId:execution.workflowId,runId:execution.runId,status:state.status.name,historySha256:sha256(encode(past)),heldPermits:0});childHistories.push(past);
 }
 const candidates=d.status.name==='COMPLETED'?[await h.result() as any]:[...completed('acquireAmazonFile'),...completed('reviewAmazonProduct')].filter(v=>v.status==='review');
 assert.equal(candidates.length,1);const result=candidates[0];assert.equal(result.status,'review');
 const rows=(await db.query('select record from review_record where review_id=$1',[result.reviewId])).rows;assert.equal(rows.length,1);const review=rows[0].record;
 assert.equal(result.code,review.failure.code);assert.ok(['amazon.browser','channel.product-input','file.acquire','channel.label-input','product.label.assembly'].includes(review.failure.stage));
 assert.deepEqual({requestId:review.observation.requestId,brandId:review.observation.brandId,sourceId:review.observation.sourceId,listingId:review.observation.listingId,variantId:review.observation.variantId},
  {requestId:job.discovery.catalogId,brandId:job.discovery.scope.brandId,sourceId:job.discovery.scope.sourceId,listingId:job.discovery.entry.listingId,variantId:job.discovery.entry.variantId});
 const closes=completed('closeAmazonProductPage');assert.equal(closes.length,1);const close=closes[0];assert.equal(close.status,'closed');assert.equal(close.taskId,job.sessionId);
 const pageRoot=c.pageJournalRoot+'/v3/browser-pages/'+sha256(encode([c.browser,job.sessionId])),opened=await read(pageRoot+'/opened.json'),closed=await read(pageRoot+'/closed.json');
 assert.deepEqual(closed,opened);assert.equal(closed.taskId,job.sessionId);assert.equal(closed.targetId,close.targetId);
 const absent=[];for(let i=0;i<3;i++){
  const snapshot:any=await new EgoCliRunner().run(c.browser.cliPath,'await useOrCreateTaskSpace(1);const snapshot={tabs:await listTabs()};',AbortSignal.timeout(15000));
  absent.push(snapshot.tabs.every((t:any)=>t.targetId!==closed.targetId));
 }assert.ok(absent.every(Boolean));
 const proof={codec:'amazon-browser-recovery/2',request:p.request,requestId:job.discovery.catalogId,workflowStatus:d.status.name,reviewId:review.reviewId,taskId:job.sessionId,targetId:closed.targetId,targetsAbsent:absent,closedSha256:sha256(await fs.readFile(pageRoot+'/closed.json')),historySha256:sha256(encode(history)),children};
 const out=dir+'/recovery-'+p.permit_id;await fs.mkdir(out,{recursive:true,mode:0o700});
 await fs.writeFile(out+'/audit.json',JSON.stringify(proof,null,2),{mode:0o600});await fs.writeFile(out+'/history.json',encode(history),{mode:0o600});
 if(mode==='--release'){
  const key='v3/amazon-history-recovery/'+p.permit_id+'/proof.json';
  const keep=async(key:string,bytes:Buffer)=>{await remote.store.create(key,bytes,'application/json',AbortSignal.timeout(30000));assert.deepEqual(Buffer.from((await remote.store.read(key,bytes.length,AbortSignal.timeout(30000)))!),bytes);};
  await keep(key.replace('proof.json','history.json'),encode(history));
  for(let n=0;n<children.length;n++)await keep(key.replace('proof.json','child-'+n+'.json'),encode(childHistories[n]));
  await keep(key,encode(proof));assert.equal((await h.describe()).status.name,d.status.name);
  for(const child of children)assert.equal((await db.query("select count(*)::int n from resource_permit where released_at is null and request->>'workflowId'=$1",[child.workflowId])).rows[0].n,0);
  await new PostgresResourceAdmission(db).release(p.request);assert.ok((await db.query('select released_at from resource_permit where permit_id=$1',[p.permit_id])).rows[0].released_at);
  await fs.writeFile(out+'/released.json',JSON.stringify({at:new Date().toISOString(),proofKey:key,permitId:p.permit_id}),{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({status:'released',proofKey:key,...proof}));
 }else console.log(JSON.stringify({status:'recoverable',...proof}));
}finally{await db.end();await connection.close();remote.close();}
