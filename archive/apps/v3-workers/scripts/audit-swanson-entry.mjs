// Read-only traversal of the actual Brand -> catalog -> family -> SKU -> label chain.
import fs from 'node:fs/promises';import assert from 'node:assert/strict';import{createRequire}from'node:module';import{hostname}from'node:os';import{createHash}from'node:crypto';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);const request=process.argv[2],final=process.argv[3]==='--final';assert.match(request,/^[a-f0-9-]{36}$/);
const root='/Users/barry/apps/crawlv3-batch-a.UiA4dx',out=root+'/live/swanson-entry-20260911/request-'+request,read=async p=>JSON.parse(await fs.readFile(p));await fs.mkdir(out,{recursive:true,mode:0o700});
const require=createRequire(root+'/package.json'),pg=require('pg'),{Client,Connection}=require('@temporalio/client'),{Worker}=require('@temporalio/worker');
const config=await read(root+'/live/swanson-coverage-deployment-20260910/swanson.private.json'),runtime=await read(root+'/live/channel-resident-20260910-v2/swanson-brand-workflow.runtime.json'),t=runtime.transport;
const db=new pg.Pool({connectionString:config.database.connectionString,options:'-c default_transaction_read_only=on',statement_timeout:5000}),connection=await Connection.connect({address:runtime.address,tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
try{
 const client=new Client({connection,namespace:runtime.namespace}),queue=['v3-collection-'+request],seen=new Set(),workflows=[],evidence=[],taskIds=new Set();
 while(queue.length){const id=queue.shift();if(seen.has(id))continue;seen.add(id);const h=client.workflow.getHandle(id),d=await h.describe(),history=await h.fetchHistory();
  for(const e of history.events??[]){const child=e.childWorkflowExecutionStartedEventAttributes?.workflowExecution?.workflowId;if(child)queue.push(child);
   const decode=p=>p?.data?.length?JSON.parse(Buffer.from(p.data).toString()):null;
   const job=decode(e.activityTaskCompletedEventAttributes?.result?.payloads?.[0]);
   if(job?.codec==='swanson-product-job/1')taskIds.add(job.sessionId+(d.type==='SwansonCatalogProductWorkflow'?'-family':''));
   if(e.activityTaskScheduledEventAttributes?.activityType?.name==='readCatalogPage'){const input=decode(e.activityTaskScheduledEventAttributes.input?.payloads?.[0]);taskIds.add('swanson-catalog-'+createHash('sha256').update(JSON.stringify(input)).digest('hex'));}
  }
  const activities={},failures=[];for(const e of history.events??[]){const a=e.activityTaskScheduledEventAttributes?.activityType?.name;if(a)activities[a]=(activities[a]??0)+1;if(e.activityTaskFailedEventAttributes)failures.push(e.activityTaskFailedEventAttributes.failure?.applicationFailureInfo?.type);}
  const item={workflowId:id,runId:d.runId,type:d.type,status:d.status.name,activities,failures,pending:d.raw.pendingActivities?.map(a=>({type:a.activityType?.name,attempt:a.attempt,state:a.state}))??[]};
  if(d.status.name==='COMPLETED')item.result=await h.result();
  if(final){assert.equal(d.status.name,'COMPLETED');await Worker.runReplayHistory({workflowBundle:{codePath:root+'/release-swanson-coverage-20260910/product-workflows.cjs'}},history,id);item.replay=true;await fs.writeFile(out+'/history-'+d.runId+'.json',JSON.stringify(history));}
  workflows.push(item);
 }
 const submission=(await db.query('SELECT snapshot FROM collection_submission WHERE request_id=$1',[request])).rows[0],rows={};assert.equal(submission.snapshot.channel,'swanson');assert.equal(submission.snapshot.sourceRevision,4);
 for(const table of ['collected_product','review_record','processing_result'])rows[table]=(await db.query(`SELECT record,record_hash FROM ${table} WHERE record::text LIKE $1`,['%'+request+'%'])).rows;
 for(const table of ['catalog_discovery','catalog_page','catalog_closure','catalog_dispatch'])evidence.push({table,rows:(await db.query(`SELECT row_to_json(t) value FROM ${table} t WHERE row_to_json(t)::text LIKE $1`,['%'+request+'%'])).rows.map(r=>r.value)});
 const permits=(await db.query('SELECT permit_id,request,released_at FROM resource_permit WHERE request->>\'workflowId\'=ANY($1::text[])',[[...seen]])).rows;
 const report={at:new Date().toISOString(),requestId:request,submission,workflows,counts:Object.fromEntries(Object.entries(rows).map(([t,r])=>[t,r.length])),held:permits.filter(p=>!p.released_at).length,permits,delivery:(await db.query('SELECT observed_status,closed_at FROM workflow_delivery WHERE request_id=$1',[request])).rows,closures:evidence.find(e=>e.table==='catalog_closure').rows};
 if(final){
  assert.equal(report.held,0);assert.equal(workflows.filter(w=>w.type==='SwansonVariantProductWorkflow').length,2);assert.equal(workflows.filter(w=>w.type==='SwansonCatalogProductWorkflow').length,2);
  const {S3Client,GetObjectCommand}=require('@aws-sdk/client-s3'),s3=new S3Client({endpoint:config.r2.endpoint,region:'auto',credentials:config.r2Credentials,maxAttempts:1,forcePathStyle:true,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'}),refs=new Map();
  const walk=v=>{if(!v||typeof v!=='object')return;if(v.objectKey&&v.sha256&&v.byteSize)refs.set(v.objectKey,v);Object.values(v).forEach(walk);};walk(rows);walk(evidence);walk(workflows);report.artifacts=[];
  try{for(const ref of refs.values()){const r=await s3.send(new GetObjectCommand({Bucket:config.r2.bucket,Key:config.r2.prefix+'/'+ref.objectKey}),{abortSignal:AbortSignal.timeout(30000)}),b=Buffer.from(await r.Body.transformToByteArray());assert.equal(b.length,ref.byteSize);assert.equal(createHash('sha256').update(b).digest('hex'),ref.sha256);report.artifacts.push({key:ref.objectKey,sha256:ref.sha256,verified:true});}}finally{s3.destroy();}
  const baseline=await read(root+'/live/swanson-coverage-2df9dfc1-33de-413b-93fa-4531a4428311/label-20260911/baseline.json');for(const[table,hashes]of Object.entries(baseline)){const current=new Set((await db.query(`SELECT record_hash FROM ${table}`)).rows.map(r=>r.record_hash));assert.ok(hashes.every(h=>current.has(h)));}report.oldHashesPreserved=true;
  const jobs=await read(root+'/status.json');assert.equal(jobs.jobs.filter(j=>j.ready).length,61);assert.ok(jobs.dependencies.every(d=>d.healthy));report.ready=61;report.globalHeld=(await db.query('SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL')).rows[0].n;report.guards=(await db.query('SELECT count(*)::int n FROM source_submission_guard')).rows[0].n;
  report.pages=[];for(const name of (await fs.readdir(config.pageJournalRoot,{recursive:true})).filter(n=>n.endsWith('/opened.json'))){const opened=await read(config.pageJournalRoot+'/'+name);if(!taskIds.has(opened.taskId))continue;const closed=await read(config.pageJournalRoot+'/'+name.replace('/opened.json','/closed.json'));assert.deepEqual(closed,opened);report.pages.push({taskId:opened.taskId,targetId:opened.targetId,closed:true});}assert.equal(report.pages.length,5);assert.equal(report.globalHeld,0);assert.equal(report.guards,0);
  await fs.writeFile(out+'/records.json',JSON.stringify({rows,evidence},null,2));report.verified=true;
 }
 await fs.writeFile(out+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({...report,permits:permits.length,artifacts:report.artifacts?.length}));
}finally{await db.end();await connection.close();}
