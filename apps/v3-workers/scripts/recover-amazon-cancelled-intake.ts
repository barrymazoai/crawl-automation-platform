/** Close only the cancelled September 13 pilot intake after its whole tree stopped. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {hostname} from 'node:os';
import pg from 'pg';
import {Client,Connection} from '@temporalio/client';
import {defaultPayloadConverter} from '@temporalio/common';
import {createR2Objects,sha256} from '@crawl-automation/v3-artifacts';
import {AmazonProductJobSchema} from '@crawl-automation/v3-contracts';
import {EgoCliRunner} from '@crawl-automation/v3-acquisition';
import {PostgresDelivery} from '../../v3-api/src/storage/postgres-delivery.js';
import {inputHash} from '../../v3-api/src/delivery/identity.js';
const root='/Users/barry/apps/crawlv3-batch-a.UiA4dx',requestId='f687da2b-db01-4dc9-aafa-0ca30a5200ae';
const mode=process.argv[2];assert.ok(['--audit','--release'].includes(mode!));assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const read=async(p:string)=>JSON.parse(await fs.readFile(p,'utf8')),encode=(v:unknown)=>Buffer.from(JSON.stringify(v));
const decode=(v:any)=>{assert.equal(v.payloads.length,1);return defaultPayloadConverter.fromPayload(v.payloads[0]) as any;};
const m=await read(root+'/live/deployment.json'),c=await read(m.jobs.find((j:any)=>j.id==='amazon-capture').env.V3_AMAZON_LIVE_CONFIG),r=await read(m.jobs.find((j:any)=>j.id==='amazon-brand-workflow').env.V3_WORKER_CONFIG),t=r.transport;
assert.equal(new URL(c.database.connectionString).pathname,'/crawler_v3_test');
const connection=await Connection.connect({address:r.address,tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}}),db=new pg.Pool({connectionString:c.database.connectionString,max:1}),remote=createR2Objects(c.r2,c.r2Credentials);
try{
 const client=new Client({connection,namespace:r.namespace}),journal=new PostgresDelivery(db),receipt=await journal.get(requestId);assert.ok(receipt);assert.equal(receipt.state,'CONFIRMED');assert.equal(receipt.lastIssue,'UNCONFIRMED_TERMINAL');
 const discovered=(await db.query('select record from catalog_discovery where catalog_id=$1',[requestId])).rows.map(x=>x.record);assert.equal(discovered.length,2);
 assert.deepEqual(discovered.map(x=>x.entry.listingId).sort(),['B0FLRRQ5KR','B0GBX7416D']);
 const allowed=new Set([`v3-collection-${requestId}`,`v3-collection-${requestId}-catalog`,...discovered.flatMap(x=>[x.workflowId,x.workflowId+'-label'])]);
 const pending=[{workflowId:`v3-collection-${requestId}`,runId:receipt.runId!}],trees:any[]=[],pages:any[]=[];let terminal:any;
 while(pending.length){
  const item=pending.shift()!;assert.ok(allowed.has(item.workflowId));assert.ok(!trees.some(x=>x.workflowId===item.workflowId));
  const h=client.workflow.getHandle(item.workflowId,item.runId),state=await h.describe(),history=await h.fetchHistory(),events=history.events??[];
  assert.equal((await client.workflow.getHandle(item.workflowId).describe()).runId,item.runId);assert.equal(state.raw.pendingActivities?.length??0,0);assert.ok(['COMPLETED','CANCELLED'].includes(state.status.name));
  const start=events[0]!.workflowExecutionStartedEventAttributes!;assert.ok(start);assert.equal(start.firstExecutionRunId,item.runId);assert.equal(start.originalExecutionRunId,item.runId);assert.ok(!start.continuedExecutionRunId);assert.equal(start.attempt??1,1);
  if(item.workflowId===`v3-collection-${requestId}`){
   assert.equal(state.status.name,'CANCELLED');assert.equal(start.workflowType!.name,receipt.target.workflowType);assert.equal(start.taskQueue!.name,receipt.target.taskQueue);assert.equal(inputHash(decode(start.input)),receipt.inputHash);
   const end=events.find(e=>e.workflowExecutionCanceledEventAttributes);assert.ok(end?.eventId&&end.eventTime);
   terminal={runId:item.runId,inputHash:receipt.inputHash,status:'CANCELLED' as const,continued:false,terminalEventId:end.eventId.toString(),closedAt:new Date(Number(end.eventTime.seconds)*1000+Number(end.eventTime.nanos??0)/1e6).toISOString()};
  }
  for(const e of events.filter(e=>e.childWorkflowExecutionStartedEventAttributes)){const w=e.childWorkflowExecutionStartedEventAttributes!.workflowExecution!;pending.push({workflowId:w.workflowId!,runId:w.runId!});}
  const completed=(name:string)=>events.filter(e=>e.activityTaskScheduledEventAttributes?.activityType?.name===name).flatMap(e=>{const end=events.find(x=>x.activityTaskCompletedEventAttributes?.scheduledEventId?.toString()===e.eventId?.toString());return end?[decode(end.activityTaskCompletedEventAttributes!.result)]:[];});
  if(state.type==='AmazonCatalogProductWorkflow'){
   const prepared=completed('prepareAmazonProduct');assert.equal(prepared.length,1);const job=AmazonProductJobSchema.parse(prepared[0]);assert.equal(job.discovery.catalogId,requestId);assert.equal(job.discovery.workflowId,item.workflowId);
   const capture=events.filter(e=>e.activityTaskScheduledEventAttributes?.activityType?.name==='captureAmazonProduct');
   if(capture.length){
    assert.equal(capture.length,1);const close=completed('closeAmazonProductPage');assert.equal(close.length,1);assert.equal(close[0].status,'closed');assert.equal(close[0].taskId,job.sessionId);
    const path=c.pageJournalRoot+'/v3/browser-pages/'+sha256(encode([c.browser,job.sessionId])),opened=await read(path+'/opened.json'),closed=await read(path+'/closed.json');assert.deepEqual(opened,closed);assert.equal(closed.taskId,job.sessionId);assert.equal(close[0].targetId,closed.targetId);
    pages.push({taskId:job.sessionId,targetId:closed.targetId,closedSha256:sha256(await fs.readFile(path+'/closed.json'))});
   }else{
    assert.equal(state.status.name,'CANCELLED');assert.ok(events.filter(e=>e.activityTaskScheduledEventAttributes).every(e=>['prepareAmazonProduct','reserveResources'].includes(e.activityTaskScheduledEventAttributes!.activityType!.name!)));
   }
  }
  trees.push({...item,status:state.status.name,type:state.type,history,historySha256:sha256(encode(history))});
 }
 assert.equal(trees.length,5);assert.ok(discovered.every(x=>trees.some(t=>t.workflowId===x.workflowId)));assert.equal(pages.length,1);
 const ids=trees.map(x=>x.workflowId),ensureReleased=async()=>assert.equal((await db.query("select count(*)::int n from resource_permit where released_at is null and request->>'workflowId'=ANY($1)",[ids])).rows[0].n,0);await ensureReleased();
 // Both prior quarantines must have verified, immutable recovery proofs.
 const recovery=[];
 for(const permit of ['permit-01a09ade-81bf-73df-85af-bf82397d696e-0','permit-01a09adf-3a99-708d-83e7-3fdfd8aa2d0a-0']){
  const key=`v3/amazon-history-recovery/${permit}/proof.json`,bytes=await remote.store.read(key,65536,AbortSignal.timeout(15000));assert.ok(bytes);const proof=JSON.parse(Buffer.from(bytes).toString());assert.equal(proof.request.permitId,permit);assert.ok(ids.includes(proof.request.workflowId));recovery.push({key,sha256:sha256(bytes)});
 }
 const checks=[];for(let i=0;i<3;i++){const snapshot:any=await new EgoCliRunner().run(c.browser.cliPath,'await useOrCreateTaskSpace(1);const snapshot={tabs:await listTabs()};',AbortSignal.timeout(15000));assert.ok(pages.every(p=>snapshot.tabs.every((t:any)=>t.targetId!==p.targetId)));checks.push({at:new Date().toISOString(),targetsAbsent:true});}
 const proof={codec:'amazon-cancelled-intake-recovery/1',requestId,terminal,trees:trees.map(({history,...x})=>x),pages,checks,recovery,heldPermits:0};
 const out='/Users/barry/apps/crawlv3-history-20260913/amazon-5-us-20260913/intake-recovery';await fs.mkdir(out,{recursive:true,mode:0o700});await fs.writeFile(out+'/audit.json',JSON.stringify(proof,null,2),{mode:0o600});
 const key=`v3/amazon-history-recovery/${requestId}/cancelled-intake-proof.json`;
 if(mode==='--release'){
  const keep=async(k:string,b:Buffer)=>{await remote.store.create(k,b,'application/json',AbortSignal.timeout(30000));assert.deepEqual(Buffer.from((await remote.store.read(k,b.length,AbortSignal.timeout(30000)))!),b);};
  await keep(key.replace('proof.json','histories.json'),encode(trees));await keep(key,encode(proof));await ensureReleased();
  for(const tree of trees){const current=await client.workflow.getHandle(tree.workflowId).describe();assert.equal(current.runId,tree.runId);assert.equal(current.status.name,tree.status);}
  const result=await journal.record(requestId,terminal);assert.equal(result.state,'CLOSED');assert.equal(result.observedStatus,'CANCELLED');await fs.writeFile(out+'/released.json',JSON.stringify({proofKey:key,result}),{mode:0o600,flag:'wx'});
 }
 console.log(JSON.stringify({status:mode==='--release'?'closed-cancelled':'recoverable',requestId,workflows:trees.length,targetsAbsent:true,heldPermits:0,proofKey:mode==='--release'?key:null}));
}finally{await db.end();await connection.close();remote.close();}
