// Read-only progress and automatic terminal acceptance for the one-member retest.
import fs from 'node:fs/promises';import assert from 'node:assert/strict';import{hostname}from'node:os';import{createHash}from'node:crypto';
import pg from 'pg';import{Client,Connection}from'@temporalio/client';import{defaultPayloadConverter}from'@temporalio/common';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const [work]=process.argv.slice(2),main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',batch='/Users/barry/apps/crawlv3-history-20260913/amazon-unified-retest-10-20260914',dir=batch+'/label-header-retry';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),decode=v=>v?.payloads?.length?defaultPayloadConverter.fromPayload(v.payloads[0]):null,sha=b=>createHash('sha256').update(b).digest('hex');
const start=await read(dir+'/started.json'),c=await read(dir+'/amazon.private.json'),r=await read(batch+'/control.runtime.json'),t=r.transport,lib=await import(work+'/candidate-v7/acceptance/purchase-conditions-inspect.js');
const connection=await Connection.connect({address:r.address,tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}}),db=new pg.Pool({connectionString:c.database.connectionString,max:1,statement_timeout:10000,options:'-c default_transaction_read_only=on'});
try{
 const client=new Client({connection,namespace:r.namespace}),root=await client.workflow.getHandle(start.workflowId).describe(),discoveries=(await db.query('SELECT record FROM catalog_discovery WHERE catalog_id=$1',[start.requestId])).rows.map(x=>x.record);
 assert.ok(discoveries.length<=1);const report={at:new Date().toISOString(),requestId:start.requestId,asin:start.asin,rootStatus:root.status.name,verified:false};
 if(discoveries.length){
  const d=discoveries[0];assert.equal(d.entry.listingId,start.asin);const h=client.workflow.getHandle(d.workflowId),s=await h.describe();report.productStatus=s.status.name;report.pending=s.raw.pendingActivities?.map(a=>a.activityType?.name)??[];
  try{const l=await client.workflow.getHandle(d.workflowId+'-label').describe();report.label={status:l.status.name,pending:l.raw.pendingActivities?.map(a=>a.activityType?.name)??[]};}catch(e){if(e.name!=='WorkflowNotFoundError')throw e;}
  if(s.status.name==='COMPLETED'){report.result=await h.result();}
  if(root.status.name==='COMPLETED'&&report.result?.status==='collected'){
   const events=(await h.fetchHistory()).events??[],done=name=>events.filter(e=>e.activityTaskScheduledEventAttributes?.activityType?.name===name).flatMap(e=>{const end=events.find(x=>x.activityTaskCompletedEventAttributes?.scheduledEventId?.toString()===e.eventId.toString());return end?[decode(end.activityTaskCompletedEventAttributes.result)]:[];});
   const [job]=done('prepareAmazonProduct'),[close]=done('closeAmazonProductPage');assert.equal(close.status,'closed');assert.equal(close.taskId,job.sessionId);
   const path=c.pageJournalRoot+'/v3/browser-pages/'+sha(Buffer.from(JSON.stringify([c.browser,job.sessionId])))+'/closed.json',bytes=await fs.readFile(path),closed=JSON.parse(bytes.toString());assert.deepEqual(closed,await read(path.replace('/closed.json','/opened.json')));assert.equal(closed.targetId,close.targetId);
   const checks=[];for(let i=0;i<3;i++){const snapshot=await new lib.EgoCliRunner().run(c.browser.cliPath,`await useOrCreateTaskSpace(${c.browser.taskSpaceId});const snapshot={tabs:await listTabs()};`,AbortSignal.timeout(20000));assert.ok(snapshot.tabs.every(t=>t.targetId!==closed.targetId));checks.push({at:new Date().toISOString(),targetsAbsent:true});}
   const rows=(await db.query("SELECT source_record_id,record FROM product_history_source WHERE dataset='v3:amazon' AND (record->'owner'->>'requestId'=$1 OR record->'collection'->'observation'->>'requestId'=$1)",[start.requestId])).rows;assert.equal(rows.length,2);assert.equal(await new lib.ProductHistory(db).verify(rows.map(x=>lib.convertHistoryInput(x.record))),2);
   const capture=rows.find(x=>x.record.codec==='v3-capture-history/1').record,formula=rows.find(x=>x.record.codec==='v3-formula-history/1').record,material=lib.productServiceMaterial(lib.convertHistoryInput(formula),capture);assert.equal(material.labels.length,1);assert.equal(material.pending.length,0);
   const content=material.labels[0].draft.label.content,blend=content.formula.columns.flatMap(c=>c.rows).find(r=>r.kind==='blend_total'&&r.name.text==='Advanced Support Complex');assert.ok(blend?.amount.text.includes('3,400 mg'));assert.ok(content.exclusions.some(e=>e.quote.text.includes('3,600 mg')));
   const labelHistory=await client.workflow.getHandle(d.workflowId+'-label').fetchHistory(),calls=labelHistory.events.filter(e=>e.activityTaskScheduledEventAttributes),images=calls.filter(e=>e.activityTaskScheduledEventAttributes.activityType.name==='interpretImage');assert.equal(images.length,1);assert.equal(calls.filter(e=>e.activityTaskScheduledEventAttributes.activityType.name==='interpretText').length,0);assert.equal(decode(images[0].activityTaskScheduledEventAttributes.input).configFingerprint,c.visionConfigFingerprint);
   const held=(await db.query("SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL AND request->>'workflowId'=ANY($1)",[[d.workflowId,d.workflowId+'-label']])).rows[0].n;assert.equal(held,0);
   const reviews=(await db.query("SELECT record->'failure'->>'code' code FROM review_record WHERE record->'observation'->>'requestId'=$1",[start.requestId])).rows;assert.equal(reviews.length,0);
   const preserved=(await db.query("SELECT count(*)::int n FROM review_record WHERE record->'observation'->>'requestId'=$1",[start.priorRequestId])).rows[0].n;assert.equal(preserved,4);
   const old=await client.workflow.getHandle('amazon-history-100-us-10001-20260913').query('progress');assert.equal(old.phase,'paused');assert.equal(old.cursor,24);
   const workers=await read(main+'/status.json');assert.ok(workers.jobs.every(j=>j.ready));assert.ok(Date.now()-Date.parse(workers.at)<20000);
   Object.assign(report,{verified:true,elapsedSeconds:(s.closeTime-s.startTime)/1000,formulaRows:content.formula.columns.map(c=>c.rows.length),actualBlendDose:blend.amount.text,equivalentLines:content.exclusions.filter(e=>/equivalent/i.test(e.quote.text)).map(e=>e.quote.text),modelImageCalls:1,modelTextCalls:0,newReviews:0,oldReviewsPreserved:preserved,held:0,historyRecordsVerified:2,workersReady:workers.jobs.length,page:{taskId:closed.taskId,targetId:closed.targetId,closedPath:path,sha256:sha(bytes),checks}});
   await fs.writeFile(dir+'/service-material.json',JSON.stringify(material,null,2),{mode:0o600});await fs.writeFile(dir+'/label-history.json',JSON.stringify(labelHistory),{mode:0o600});
  }
 }
 await fs.writeFile(dir+'/inspection.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
}finally{await db.end();await connection.close();}
