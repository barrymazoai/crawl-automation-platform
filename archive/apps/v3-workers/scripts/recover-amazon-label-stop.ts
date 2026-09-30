import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {hostname} from 'node:os';
import {gzipSync,gunzipSync} from 'node:zlib';
import {Client,Connection} from '@temporalio/client';
import pg from 'pg';
import {AmazonProductJobSchema,ResourceRequestSchema,TextInputSchema,VisionTaskSchema,observationIdentity} from '@crawl-automation/v3-contracts';
import {createR2Objects,RetainedPublication,sha256} from '@crawl-automation/v3-artifacts';
import {TextLocalStore} from '@crawl-automation/v3-text';
import {visionFingerprint} from '@crawl-automation/v3-vision';
import {PostgresReviews} from '@crawl-automation/v3-review';
import {EgoCliRunner} from '@crawl-automation/v3-acquisition';
import {PostgresResourceAdmission} from '../../../packages/v3-product/src/resource-admission.js';
import {QualityReviewStops} from '../src/quality-review-stops.js';
import {historyEffects,historyValue,stoppedModelReviewChecks} from '../src/stopped-model-recovery.js';
import {labelRecoveryKey,recoveredAmazonLabelFailure} from '../src/amazon-label-terminal-proof.js';

const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',root='/Users/barry/apps/crawlv3-history-20260913/amazon-resource-recovery-20260914';
const read=async(p:string)=>JSON.parse(await fs.readFile(p,'utf8')),bytes=(x:unknown)=>Buffer.from(JSON.stringify(x));
let phase='startup';
async function execute(){
 assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
 const mode=process.argv[2],requestId=process.argv[3];assert.ok(['--audit-request','--release-request'].includes(mode!));assert.match(requestId??'',/^[a-f0-9-]{36}$/);
 const apply=mode==='--release-request',m=await read(main+'/live/deployment.json');
 const c=await read(m.jobs.find((j:any)=>j.id==='amazon-control').env.V3_AMAZON_LIVE_CONFIG),lc=await read(m.jobs.find((j:any)=>j.id==='amazon-channel-label-resources').env.V3_CHANNEL_LABEL_CONFIG);
 assert.deepEqual(c.r2,lc.r2);assert.equal(c.deliveryPostalCode,'10001');assert.ok(c.linkBatches.some((b:any)=>b.requestId===requestId));
 const r=await read(m.jobs.find((j:any)=>j.id==='amazon-brand-workflow').env.V3_WORKER_CONFIG),t=r.transport;
 const connection=await Connection.connect({address:r.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
 const db=new pg.Pool({connectionString:c.database.connectionString,max:1,connectionTimeoutMillis:5000,statement_timeout:5000}),rd=lc.resourceDatabase??lc.database;
 const resources=new pg.Pool({connectionString:rd.connectionString,max:1,connectionTimeoutMillis:5000,statement_timeout:5000}),remote=createR2Objects(c.r2,c.r2Credentials);
 const signal=AbortSignal.timeout(apply?140000:480000);
 try{
  assert.equal((await db.query('select current_database() name')).rows[0].name,'crawler_v3_test');
  const client=new Client({connection,namespace:r.namespace}),discoveries=(await db.query('select record from catalog_discovery where catalog_id=$1',[requestId])).rows.map(x=>x.record);
  assert.equal(discoveries.length,1,'Recovery requires one exact product');const d=discoveries[0],parent=client.workflow.getHandle(d.workflowId),state=await parent.describe();
  assert.equal(state.type,'AmazonCatalogProductWorkflow');assert.ok(['COMPLETED','FAILED'].includes(state.status.name));assert.equal(state.raw.pendingActivities?.length??0,0);
  const heldCount=async()=>(await resources.query("select count(*)::int n from resource_permit where released_at is null and request->>'workflowId'=ANY($1)",[[d.workflowId,d.workflowId+'-label']])).rows[0].n;
  if(!await heldCount()&&state.status.name==='FAILED'&&await recoveredAmazonLabelFailure(d,state.runId,db,resources,remote.store,signal))
   return{status:'settled',requestId,proofKey:labelRecoveryKey(state.runId),alreadyRecovered:true};
  const history=async(workflowId:string,runId:string)=>{
   const cache=root+'/histories/'+runId,meta=await read(cache+'.json').catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;return null;});
   if(meta){assert.equal(meta.workflowId,workflowId);assert.equal(meta.runId,runId);const retained=await fs.readFile(cache+'.json.gz');assert.equal(sha256(retained),meta.sha256);return JSON.parse(gunzipSync(retained).toString());}
   const events:any[]=[];let token:Uint8Array|undefined;
   do{signal.throwIfAborted();const page=await connection.withDeadline(Date.now()+15000,()=>connection.workflowService.getWorkflowExecutionHistory({namespace:r.namespace,execution:{workflowId,runId},maximumPageSize:1000,...(token?{nextPageToken:token}:{})}));
    events.push(...(page.history?.events??[]));token=page.nextPageToken;if(events.length>100000)throw Error('RESOURCE.RECOVERY_HISTORY_LIMIT');
   }while(token?.length);
   const content=gzipSync(bytes({events}));await fs.mkdir(root+'/histories',{recursive:true,mode:0o700});
   await fs.writeFile(cache+'.json.gz',content,{flag:'wx',mode:0o600});await fs.writeFile(cache+'.json',bytes({workflowId,runId,sha256:sha256(content)}),{flag:'wx',mode:0o600});return{events};
  };
  phase='history';const parentHistory=await history(d.workflowId,state.runId),pe=parentHistory.events;
  const jobs=historyEffects(pe,'prepareAmazonProduct');assert.equal(jobs.length,1);assert.ok(jobs[0]!.completed);const job=AmazonProductJobSchema.parse(jobs[0]!.output);assert.deepEqual(job.discovery,d);
  const retainedJob=await remote.store.read('v3/amazon-jobs/'+d.discoveryId+'.json',65536,signal);assert.ok(retainedJob);assert.deepEqual(JSON.parse(Buffer.from(retainedJob).toString()),job);
  const started=pe.filter((e:any)=>e.childWorkflowExecutionStartedEventAttributes);assert.equal(started.length,1);const childRef=started[0]!.childWorkflowExecutionStartedEventAttributes.workflowExecution;
  assert.equal(childRef.workflowId,d.workflowId+'-label');
  const childHandle=client.workflow.getHandle(childRef.workflowId,childRef.runId),childState=await childHandle.describe();assert.equal(childState.raw.pendingActivities?.length??0,0);
  const childHistory=await history(childRef.workflowId,childRef.runId),ce=childHistory.events,childStart=ce[0]!.workflowExecutionStartedEventAttributes;
  assert.equal(childStart.parentWorkflowExecution.workflowId,d.workflowId);assert.equal(childStart.parentWorkflowExecution.runId,state.runId);
  const childInput=historyValue(childStart.input);assert.equal(childInput.input.sourcePlan.owner.requestId,requestId);assert.equal(childInput.input.sourcePlan.owner.listingId,d.entry.listingId);
  const rows=(await resources.query("select request,released_at from resource_permit where request->>'workflowId'=$1 and request->>'runId'=$2",[childRef.workflowId,childRef.runId])).rows;
  const retainedProof=await remote.store.read(labelRecoveryKey(state.runId),131072,signal),prior=retainedProof?JSON.parse(Buffer.from(retainedProof).toString()):undefined;
  if(prior){assert.equal(prior.codec,'amazon-label-stop-recovery/1');assert.deepEqual(prior.discovery,d);assert.equal(prior.runId,state.runId);assert.equal(prior.child.runId,childRef.runId);}
  const held:Array<ReturnType<typeof ResourceRequestSchema.parse>>=(prior?prior.stops.map((s:any)=>s.request):rows.filter(x=>!x.released_at).map(x=>x.request)).map((p:unknown)=>ResourceRequestSchema.parse(p));assert.ok(held.length>0,'No unverified child permit to recover');
  for(const p of held)assert.deepEqual(rows.find(x=>x.request.permitId===p.permitId)?.request,p);
  phase='model-proof';const checks=stoppedModelReviewChecks(held,{workflowId:childRef.workflowId,runId:childRef.runId,status:childState.status.name,type:childState.type},ce);
  const reviews=new PostgresReviews(db),attestations=[];
  for(const check of checks){
   const review=await reviews.read(check.check.outcome.reviewId);assert.ok(review);assert.equal(review.failure.executionFact,'executed');assert.match(review.failure.code,/^(TEXT|VISION)\.LABEL_[A-Z_]+$|^TEXT\.CITATION_INVALID$/);
   const task=check.check.activityName==='interpretText'?TextInputSchema.parse(check.task):VisionTaskSchema.parse(check.task);
   const fingerprint='source' in task?task.inputFingerprint:visionFingerprint(task),owner='source' in task?observationIdentity(task):task.input.selection.observation;
   assert.deepEqual(owner,check.owner);assert.deepEqual(review.observation,owner);assert.equal(review.failure.operationId,check.operationId);assert.equal(review.failure.inputFingerprint,fingerprint);
   const key='v3/model-returns/'+sha256(bytes([childRef.workflowId,childRef.runId,check.check.activityName,check.operationId]))+'.json';
   const saved=await remote.store.read(key,65536,signal);assert.ok(saved);const record=JSON.parse(Buffer.from(saved).toString()),inv=record.invocation;
   assert.equal(record.codec,'model-return-attestation/1');assert.equal(record.reviewId,review.reviewId);assert.equal(inv.activityId,check.activityId);assert.equal(inv.workflowId,childRef.workflowId);assert.equal(inv.runId,childRef.runId);
   assert.equal(inv.activityName,check.check.activityName);assert.equal(inv.operationId,check.operationId);assert.equal(inv.inputFingerprint,fingerprint);assert.deepEqual(inv.owner,owner);assert.match(inv.returned,/^[a-f0-9]{64}$/);
   attestations.push({key,sha256:sha256(saved),reviewId:review.reviewId});
  }
  phase='page-proof';const close=historyEffects(pe,'closeAmazonProductPage');assert.equal(close.length,1);assert.equal(close[0]!.output?.status,'closed');assert.equal(close[0]!.output.taskId,job.sessionId);
  const browser=(await resources.query("select request,released_at from resource_permit where request->>'workflowId'=$1 and request->>'runId'=$2",[d.workflowId,state.runId])).rows;
  assert.equal(browser.length,1);assert.ok(browser[0].released_at,'Normal browser release must already be confirmed');assert.deepEqual(browser[0].request.needs,[{resourceId:c.browserResource,units:1}]);
  const pageRoot=c.pageJournalRoot+'/v3/browser-pages/'+sha256(bytes([c.browser,job.sessionId])),closedBytes=await fs.readFile(pageRoot+'/closed.json'),closed=JSON.parse(closedBytes.toString());
  assert.deepEqual(closed,await read(pageRoot+'/opened.json'));assert.equal(closed.taskId,job.sessionId);assert.equal(closed.targetId,close[0]!.output.targetId);
  const targetsAbsent:boolean[]=[];
  for(let i=0;i<3;i++){const snapshot:any=await new EgoCliRunner().run(c.browser.cliPath,'await useOrCreateTaskSpace(1);const snapshot={tabs:await listTabs()};',AbortSignal.timeout(15000));
   assert.ok(snapshot.tabs.every((tab:any)=>tab.targetId!==closed.targetId));targetsAbsent.push(true);}
  await fs.mkdir(root,{recursive:true,mode:0o700});
  for(const [name,historyBytes] of [['parent',gzipSync(bytes(parentHistory))],['child',gzipSync(bytes(childHistory))]] as const){
   const path=root+'/'+state.runId+'.'+name+'-history.json.gz';try{await fs.writeFile(path,historyBytes,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;assert.equal(sha256(await fs.readFile(path)),sha256(historyBytes));}
  }
  if(!apply)return{status:'recoverable',requestId,workflowId:d.workflowId,childStatus:childState.status.name,permits:held.map(p=>p.permitId),attestations,targetsAbsent,historyRoot:root,parentRunId:state.runId};
  phase='stop-publish';const local=await TextLocalStore.open(lc.root+'/resources/journal'),stops=new QualityReviewStops(new RetainedPublication(local,remote.store),reviews,true),stopProofs=[];
  for(const check of checks){const result=await stops.verify(check.check,signal);assert.equal(result.status,'stopped');assert.ok('evidenceKey' in result);
   const saved=await remote.store.read(result.evidenceKey!,65536,signal);assert.ok(saved);stopProofs.push({request:check.request,evidenceKey:result.evidenceKey,sha256:sha256(saved)});}
  phase='retention';const prefix=`v3/amazon-label-recovery/${state.runId}/`,retain=async(name:string,content:Buffer)=>{
   const key=prefix+name;let saved=await remote.store.read(key,16*1024*1024,signal);
   if(!saved){try{await remote.store.create(key,content,'application/octet-stream',signal);}catch{/* Only exact readback follows. */}saved=await remote.store.read(key,16*1024*1024,signal);}
   assert.ok(saved);assert.equal(sha256(saved),sha256(content));return{key,sha256:sha256(content),byteSize:content.length};
  };
  const proof={codec:'amazon-label-stop-recovery/1',requestId,discovery:d,workflowId:d.workflowId,runId:state.runId,status:state.status.name,
   history:await retain('parent-history.json.gz',gzipSync(bytes(parentHistory))),child:{workflowId:childRef.workflowId,runId:childRef.runId,status:childState.status.name,history:await retain('child-history.json.gz',gzipSync(bytes(childHistory)))},
   taskId:job.sessionId,targetId:closed.targetId,targetsAbsent,closedSha256:sha256(closedBytes),closed:await retain('closed.json',closedBytes),attestations,stops:stopProofs};
  const proofKey=(await retain('proof.json',bytes(proof))).key;await fs.writeFile(root+'/'+state.runId+'.json',JSON.stringify(proof,null,2),{mode:0o600});
  assert.equal((await parent.describe()).runId,state.runId);assert.equal((await childHandle.describe()).status.name,childState.status.name);
  phase='release';const ledger=new PostgresResourceAdmission(resources);
  for(const check of checks){try{await ledger.release(check.request);}catch{/* Reconcile the exact committed row. */}const after=await ledger.read(check.request.permitId);assert.ok(after?.released);assert.deepEqual(after.request,check.request);}
  assert.equal(await heldCount(),0);if(state.status.name==='FAILED')assert.ok(await recoveredAmazonLabelFailure(d,state.runId,db,resources,remote.store,signal));
  return{status:'settled',requestId,proofKey,permits:held.map(p=>p.permitId),reviewsPreserved:true,targetsAbsent};
 }finally{await db.end();await resources.end();remote.close();await connection.close();}
}
execute().then(result=>console.log(JSON.stringify(result))).catch(error=>{
 const message=error instanceof Error?error.message:'';console.error(JSON.stringify({event:'AMAZON_LABEL_RECOVERY_BLOCKED',phase,code:/^RESOURCE\.[A-Z_]+$/.test(message)?message:'RESOURCE.RECOVERY_UNVERIFIED'}));process.exitCode=1;
});
