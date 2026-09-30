// Explicit recovery of this settled test's CODEX_CLOSED call. No model retry.
// The old activity identity, terminal histories and an actual whole-worker stop
// are required; Review status alone never authorizes release.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {hostname} from 'node:os';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pg from 'pg';
import {Client,Connection} from '@temporalio/client';
import {Worker} from '@temporalio/worker';
import {defaultPayloadConverter} from '@temporalio/common';
const [work,mode]=process.argv.slice(2),apply=mode==='--release',main='/Users/barry/apps/crawlv3-batch-a.UiA4dx';
assert.ok(['--audit','--release'].includes(mode));assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),sha=b=>createHash('sha256').update(b).digest('hex'),run=promisify(execFile),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const decode=v=>v?.payloads?.length===1?defaultPayloadConverter.fromPayload(v.payloads[0]):null;
const lib=await import(work+'/candidate/acceptance/purchase-conditions-inspect.js'),m=await read(main+'/live/deployment.json'),c=await read(work+'/amazon.private.json'),r=await read(work+'/control.runtime.json'),t=r.transport,started=await read(work+'/started.json');
const job=m.jobs.find(j=>j.id==='amazon-channel-label-vision'),healthPath=main+'/'+job.id+'.health.json',health=await read(healthPath),before=await read(main+'/status.json');
assert.equal(health.event,'WORKER_RUNNING');assert.ok(before.jobs.every(j=>j.ready));assert.equal(health.pid,before.jobs.find(j=>j.id===job.id).pid);
const connection=await Connection.connect({address:r.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
const db=new pg.Pool({connectionString:c.database.connectionString,max:1,statement_timeout:10000,...(!apply?{options:'-c default_transaction_read_only=on'}:{})}),remote=lib.createR2Objects(c.r2,c.r2Credentials),client=new Client({connection,namespace:r.namespace});
const controller=main+'/release-independent-control-20260913/independent-deployment/deployment-launchd.js';
let stopped=false;
try{
 assert.equal((await db.query('select current_database() name')).rows[0].name,'crawler_v3_test');
 const ds=(await db.query('select record from catalog_discovery where catalog_id=$1',[started.requestId])).rows.map(r=>r.record);assert.equal(ds.length,10);
 for(const d of ds){const state=await client.workflow.getHandle(d.workflowId).describe();assert.equal(state.status.name,'COMPLETED');assert.equal(state.raw.pendingActivities?.length??0,0);}
 for await(const w of client.workflow.list({query:"ExecutionStatus = 'Running'"}))assert.ok(['AmazonHistoryBatchWorkflow','DtcNodeSessionWorkflow'].includes(w.type)||[started.workflowId,started.workflowId+'-catalog'].includes(w.workflowId),'Unrelated active work');
 const old=await client.workflow.getHandle('amazon-history-100-us-10001-20260913').query('progress');assert.equal(old.phase,'paused');assert.equal(old.cursor,24);
 const held=(await db.query("select request from resource_permit where released_at is null")).rows;assert.equal(held.length,1);const request=held[0].request;
 assert.deepEqual([...request.needs].sort((a,b)=>a.resourceId.localeCompare(b.resourceId)),[{resourceId:'mini-cpu',units:1},{resourceId:'mini-model-account',units:1}]);
 const d=ds.find(d=>d.workflowId+'-label'===request.workflowId);assert.ok(d);assert.equal(d.entry.listingId,'B01IAI2MB8');
 const h=client.workflow.getHandle(request.workflowId,request.runId),state=await h.describe(),history=await h.fetchHistory(),events=history.events;
 assert.equal(state.status.name,'COMPLETED');assert.equal(state.type,'ChannelStreamingLabelWorkflow');assert.equal(state.raw.pendingActivities?.length??0,0);assert.ok(events.at(-1).workflowExecutionCompletedEventAttributes);
 const matches=events.filter(e=>e.activityTaskScheduledEventAttributes?.activityType?.name==='verifyResourceReviewStopped').map(e=>({e,input:decode(e.activityTaskScheduledEventAttributes.input)})).filter(x=>equal(x.input.request,request));assert.equal(matches.length,1);
 const check=matches[0].input;assert.equal(check.activityName,'interpretImage');assert.equal(check.outcome.code,'VISION.CODEX_CLOSED');assert.equal(check.outcome.status,'review');
 const review=(await db.query('select record from review_record where review_id=$1',[check.outcome.reviewId])).rows[0]?.record;assert.ok(review);assert.equal(review.observation.requestId,started.requestId);
 let owned;
 for(const e of events.filter(e=>['interpretImage','interpretText','ocrFile'].includes(e.activityTaskScheduledEventAttributes?.activityType?.name))){
  const a=e.activityTaskScheduledEventAttributes,completion=events.find(x=>x.activityTaskCompletedEventAttributes?.scheduledEventId?.toString()===e.eventId.toString()),start=events.find(x=>x.activityTaskStartedEventAttributes?.scheduledEventId?.toString()===e.eventId.toString());assert.ok(completion);assert.equal(Number(start.activityTaskStartedEventAttributes.attempt??1),1);
  const result=decode(completion.activityTaskCompletedEventAttributes.result);if(result?.reviewId===check.outcome.reviewId){assert.equal(start.activityTaskStartedEventAttributes.identity,health.identity);owned={activityId:a.activityId,result,task:decode(a.input)};}
 }assert.ok(owned);
 const labelJob=m.jobs.find(j=>j.id==='amazon-channel-label-workflow'),bundlePath=path.join(path.dirname(labelJob.entry),'product-workflows.cjs');
 await Worker.runReplayHistory({workflowBundle:{codePath:bundlePath}},history,request.workflowId);
 const processes=async()=>{const {stdout}=await run('/bin/ps',['-axo','pid=,ppid=']);return stdout.trim().split('\n').map(s=>{const [pid,ppid]=s.trim().split(/\s+/).map(Number);return{pid,ppid};});};
 const all=await processes(),ownedPids=new Set([health.pid]);let changed=true;while(changed){changed=false;for(const p of all)if(ownedPids.has(p.ppid)&&!ownedPids.has(p.pid)){ownedPids.add(p.pid);changed=true;}}
 // No live provider child is expected after the completed Activity. Do not kill
 // an unexplained process; investigate instead of broadening recovery scope.
 assert.equal(ownedPids.size,1,'Unexpected live provider child');
 const proof={codec:'manual-owned-model-worker-stop/1',request,reviewId:check.outcome.reviewId,reviewSha256:sha(Buffer.from(JSON.stringify(review))),workflowStatus:state.status.name,historySha256:sha(Buffer.from(JSON.stringify(history))),workflowBundleSha256:sha(await fs.readFile(bundlePath)),worker:{id:job.id,pid:health.pid,identity:health.identity,buildId:health.buildId,entry:job.entry},ownedPids:[...ownedPids],activityId:owned.activityId,modelResultPreserved:true};
 const dir=work+'/closed-model-recovery';await fs.mkdir(dir,{recursive:true,mode:0o700});await fs.writeFile(dir+'/history.json',JSON.stringify(history),{mode:0o600});
 if(!apply){await fs.writeFile(dir+'/audit.json',JSON.stringify(proof,null,2),{mode:0o600});console.log(JSON.stringify({recoverable:true,permitId:request.permitId,worker:job.id,modelCalls:0}));}
 else{
  const current=await read(healthPath);for(const k of ['pid','identity','buildId','event'])assert.equal(current[k],health[k]);const result=await run(m.node,[controller,'stop',main+'/live/deployment.json',job.id],{timeout:180000,maxBuffer:1048576});assert.deepEqual(JSON.parse(result.stdout).stopped,[job.id]);stopped=true;
  const checks=[];for(let n=0;n<3;n++){const p=await processes();assert.ok(p.every(p=>!ownedPids.has(p.pid)&&!ownedPids.has(p.ppid)));checks.push({at:new Date().toISOString(),allOwnedPidsAbsent:true});if(n<2)await sleep(200);}
  assert.equal((await client.workflow.getHandle(request.workflowId,request.runId).describe()).status.name,'COMPLETED');
  const value={...proof,stoppedAt:new Date().toISOString(),checks},bytes=Buffer.from(JSON.stringify(value)),key='v3/manual-model-stop/'+request.permitId+'/proof.json',signal=AbortSignal.timeout(30000);
  assert.equal(await remote.store.create(key,bytes,'application/json',signal),'created');assert.deepEqual(Buffer.from(await remote.store.read(key,131072,signal)),bytes);await fs.writeFile(dir+'/proof.json',JSON.stringify(value,null,2),{flag:'wx',mode:0o600});
  const ledger=new lib.PostgresResourceAdmission(db);await ledger.release(request);assert.equal((await ledger.read(request.permitId)).released,true);
  assert.equal(sha(Buffer.from(JSON.stringify((await db.query('select record from review_record where review_id=$1',[check.outcome.reviewId])).rows[0].record))),proof.reviewSha256);
  console.log(JSON.stringify({released:true,permitId:request.permitId,proofKey:key,reviewPreserved:true}));
 }
}finally{
 if(stopped){const result=await run(m.node,[controller,'start',main+'/live/deployment.json',job.id],{timeout:180000,maxBuffer:1048576});const after=await read(healthPath);assert.equal(JSON.parse(result.stdout).ready[0].id,job.id);assert.equal(after.buildId,health.buildId);assert.notEqual(after.pid,health.pid);console.log(JSON.stringify({workerRestored:true,id:job.id,pid:after.pid,buildId:after.buildId}));}
 await db.end();remote.close();await connection.close();
}
