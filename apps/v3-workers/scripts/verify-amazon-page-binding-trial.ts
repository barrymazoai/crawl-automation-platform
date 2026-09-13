/** Read-only observation/closeout of the one fresh Brand/Temporal acceptance. */
import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {hostname} from 'node:os';
import pg from 'pg';import {Client,Connection} from '@temporalio/client';import {defaultPayloadConverter} from '@temporalio/common';
import {AmazonProductCaptureSchema,FileAcquireOutcomeSchema} from '@crawl-automation/v3-contracts';
import {createR2Objects,sha256,verifyBytes} from '@crawl-automation/v3-artifacts';import {EgoCliRunner} from '@crawl-automation/v3-acquisition';
import {inspectMedia} from '../../../packages/v3-acquisition/src/media.js';
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',dir='/Users/barry/apps/crawlv3-history-20260913/amazon-page-binding-20260913',read=async(p:string)=>JSON.parse(await fs.readFile(p,'utf8'));
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const trial=await read(dir+'/trial.json'),c=await read(dir+'/amazon.private.json'),m=await read(main+'/live/deployment.json'),r=await read(m.jobs.find((j:any)=>j.id==='amazon-brand-workflow').env.V3_WORKER_CONFIG),t=r.transport;
const connection=await Connection.connect({address:r.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}}),db=new pg.Pool({connectionString:c.database.connectionString,max:1,statement_timeout:5000});
try{
 const client=new Client({connection,namespace:r.namespace}),root=await client.workflow.getHandle('v3-collection-'+trial.requestId).describe();
 const discoveries=(await db.query('select record from catalog_discovery where catalog_id=$1',[trial.requestId])).rows.map(x=>x.record);assert.ok(discoveries.length<=1);
 const report:any={at:new Date().toISOString(),requestId:trial.requestId,root:{workflowId:root.workflowId,runId:root.runId,status:root.status.name},products:[]};
 for(const d of discoveries){
  assert.equal(d.entry.listingId,'B0GBX7416D');const h=client.workflow.getHandle(d.workflowId),s=await h.describe(),events=(await h.fetchHistory()).events??[];
  const completed=(name:string)=>events.filter(e=>e.activityTaskScheduledEventAttributes?.activityType?.name===name).flatMap(e=>{const end=events.find(x=>x.activityTaskCompletedEventAttributes?.scheduledEventId?.toString()===e.eventId?.toString());return end?[defaultPayloadConverter.fromPayload(end.activityTaskCompletedEventAttributes!.result!.payloads![0]!) as any]:[];});
  const captures=completed('captureAmazonProduct'),files=completed('acquireAmazonFile').map(x=>FileAcquireOutcomeSchema.parse(x)),closed=completed('closeAmazonProductPage');
  const children=[];for(const e of events.filter(x=>x.childWorkflowExecutionStartedEventAttributes)){const child=e.childWorkflowExecutionStartedEventAttributes!.workflowExecution!,ch=client.workflow.getHandle(child.workflowId!,child.runId!),cs=await ch.describe();children.push({workflowId:child.workflowId,status:cs.status.name,pending:cs.raw.pendingActivities?.map(a=>a.activityType?.name)??[],...(cs.status.name==='COMPLETED'?{result:await ch.result()}: {})});}
  const product:any={asin:d.entry.listingId,workflowId:d.workflowId,runId:s.runId,status:s.status.name,pending:s.raw.pendingActivities?.map(a=>a.activityType?.name)??[],captures:captures.length,files:files.map(f=>f.status==='durable'?{status:f.status,operationId:f.operationId,byteSize:f.file.byteSize,sha256:f.file.sha256}:{status:f.status,code:f.code}),pageClose:closed,children};
  if(s.status.name==='COMPLETED')product.result=await h.result();
  report.products.push(product);
  if(process.argv.includes('--closeout')){
   assert.equal(root.status.name,'COMPLETED');assert.equal(s.status.name,'COMPLETED');assert.ok(children.every(x=>x.status==='COMPLETED'));assert.equal(captures.length,1);const captured=AmazonProductCaptureSchema.parse(captures[0]);
   const r2=createR2Objects(c.r2,c.r2Credentials);
   try{
    const bytes=await r2.store.read(captured.sourcePlan.source.objectKey,4*1024*1024,AbortSignal.timeout(15000));assert.ok(bytes);verifyBytes(captured.sourcePlan.source,bytes,4*1024*1024);const p=JSON.parse(Buffer.from(bytes).toString());
    assert.equal(p.asin,trial.asin);assert.equal(p.url,trial.batch.entries[0].entry.url+'?th=1');assert.match(p.deliveryText,/10001/);assert.equal(p.galleryCount,7);assert.equal(files.length,new Set(p.gallery.map((i:any)=>i.url)).size);
    product.actualUrl=p.url;product.expectedUrl=captured.sourcePlan.expectedUrl;product.galleryCount=p.galleryCount;product.images=[];
    for(const f of files){assert.equal(f.status,'durable');if(f.status!=='durable')throw Error('FILE_REVIEW');const b=await r2.store.read(f.file.objectKey,f.file.byteSize,AbortSignal.timeout(15000));assert.ok(b);verifyBytes(f.file,b,4*1024*1024);const image=inspectMedia(b,f.file.mediaType,40000000);product.images.push({objectKey:f.file.objectKey,byteSize:f.file.byteSize,sha256:f.file.sha256,dimensions:image.dimensions});}
   }finally{r2.close();}
   assert.equal(closed.length,1);assert.equal(closed[0].status,'closed');assert.equal(closed[0].taskId,captured.job.sessionId);
   const path=c.pageJournalRoot+'/v3/browser-pages/'+sha256(Buffer.from(JSON.stringify([c.browser,captured.job.sessionId]))),opened=await read(path+'/opened.json'),close=await read(path+'/closed.json');assert.deepEqual(opened,close);assert.equal(close.targetId,closed[0].targetId);
   product.closedJournalSha256=sha256(await fs.readFile(path+'/closed.json'));product.absenceChecks=[];
   for(let n=0;n<3;n++){const snapshot:any=await new EgoCliRunner().run(c.browser.cliPath,'await useOrCreateTaskSpace(1);const snapshot={tabs:await listTabs()};',AbortSignal.timeout(15000));assert.ok(snapshot.tabs.every((t:any)=>t.targetId!==close.targetId));product.absenceChecks.push({at:new Date().toISOString(),targetsAbsent:true});}
  }
 }
 report.heldPermits=(await db.query("select count(*)::int n from resource_permit where released_at is null and request->>'workflowId'=ANY($1)",[discoveries.flatMap(d=>[d.workflowId,d.workflowId+'-label'])])).rows[0].n;
 report.intakeGuards=(await db.query('select count(*)::int n from source_submission_guard where request_id=$1',[trial.requestId])).rows[0].n;
 report.reviews=(await db.query("select review_id,record->'failure'->>'code' code from review_record where record->'observation'->>'requestId'=$1",[trial.requestId])).rows;
 if(process.argv.includes('--closeout')){assert.equal(discoveries.length,1);assert.equal(report.heldPermits,0);assert.equal(report.intakeGuards,0);await fs.writeFile(dir+'/closeout.json',JSON.stringify(report,null,2),{flag:'wx',mode:0o600});}
 await fs.writeFile(dir+'/progress.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
}finally{await db.end();await connection.close();}
