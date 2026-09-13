/** Exact old pilot recovery, using retained model output and process-exit evidence.
 * Does not retry work, fabricate a stop attestation, or modify the original Review. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {hostname} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pg from 'pg';
import {Client,Connection} from '@temporalio/client';
import {defaultPayloadConverter} from '@temporalio/common';
import {ResourceRequestSchema,TextInputSchema,observationIdentity} from '@crawl-automation/v3-contracts';
import {createR2Objects,sha256} from '@crawl-automation/v3-artifacts';
import {TextLocalStore} from '@crawl-automation/v3-text';
import {PostgresReviews} from '@crawl-automation/v3-review';
import {PostgresResourceAdmission} from '../../../packages/v3-product/src/resource-admission.js';

const root='/Users/barry/apps/crawlv3-batch-a.UiA4dx';
const workflowId='catalog-product-694d52bc043cfe5e4411027fdced3a5e41f53ab974681ab09b647f5fbf94ad99-label';
const runId='01a09adf-3a99-708d-83e7-3fdfd8aa2d0a',permitId=`permit-${runId}-0`;
const reviewId='text-466c8077-7bcb-4094-bf51-eb01d03a8c97';
const out='/Users/barry/apps/crawlv3-history-20260913/amazon-2000-us-20260913/recovery-'+permitId;
const read=async(p:string)=>JSON.parse(await fs.readFile(p,'utf8'));
const encode=(v:unknown)=>Buffer.from(JSON.stringify(v));
const decode=(v:any)=>{assert.equal(v.payloads.length,1);return defaultPayloadConverter.fromPayload(v.payloads[0]) as any;};
const mode=process.argv[2];assert.ok(['--audit','--release'].includes(mode!));assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const manifest=await read(root+'/live/deployment.json'),job=manifest.jobs.find((j:any)=>j.id==='amazon-channel-label-text');
const c=await read(job.env.V3_CHANNEL_LABEL_CONFIG),r=await read(job.env.V3_WORKER_CONFIG),t=r.transport;
assert.equal(new URL(c.database.connectionString).pathname,'/crawler_v3_test');assert.equal(c.r2.bucket,'supply-smart-test');assert.equal(t.mode,'mtls');
const connection=await Connection.connect({address:r.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
const db=new pg.Pool({connectionString:c.database.connectionString,max:1,statement_timeout:5000}),remote=createR2Objects(c.r2,c.r2Credentials);
try{
 const client=new Client({connection,namespace:r.namespace}),h=client.workflow.getHandle(workflowId,runId),d=await h.describe(),history=await h.fetchHistory();
 assert.equal(d.runId,runId);assert.equal(d.type,'ChannelStreamingLabelWorkflow');assert.equal(d.status.name,'COMPLETED');assert.equal(d.raw.pendingActivities?.length??0,0);
 const ledger=new PostgresResourceAdmission(db),held=await ledger.read(permitId);assert.ok(held);assert.equal(held.released,false);
 const request=ResourceRequestSchema.parse(held.request);assert.equal(request.workflowId,workflowId);assert.equal(request.runId,runId);
 assert.deepEqual([...request.needs].sort((a,b)=>a.resourceId.localeCompare(b.resourceId)),[{resourceId:'mini-cpu',units:1},{resourceId:'mini-model-account',units:1}]);
 const events=history.events??[],scheduled=events.filter(e=>e.activityTaskScheduledEventAttributes);
 const done=(e:any)=>{const matches=events.filter(x=>x.activityTaskCompletedEventAttributes?.scheduledEventId?.toString()===e.eventId.toString());assert.equal(matches.length,1);return matches[0]!;};
 const grants=scheduled.filter(e=>e.activityTaskScheduledEventAttributes!.activityType!.name==='reserveResources');assert.equal(grants.length,1);
 assert.deepEqual(decode(grants[0]!.activityTaskScheduledEventAttributes!.input),request);
 const grant=decode(done(grants[0]).activityTaskCompletedEventAttributes!.result);assert.equal(grant.status,'granted');assert.equal(grant.permitId,permitId);
 const calls=scheduled.filter(e=>['interpretText','interpretImage','executeOcr','invokeOcr','callOcr'].includes(e.activityTaskScheduledEventAttributes!.activityType!.name!));assert.equal(calls.length,1);
 const call=calls[0]!;assert.equal(call.activityTaskScheduledEventAttributes!.activityType!.name,'interpretText');
 const input=TextInputSchema.parse(decode(call.activityTaskScheduledEventAttributes!.input)),completion=done(call),receipt=decode(completion.activityTaskCompletedEventAttributes!.result);
 assert.ok(Number(call.eventId)>Number(done(grants[0]).eventId));assert.equal(receipt.status,'review');assert.equal(receipt.code,'TEXT.CITATION_INVALID');assert.equal(receipt.reviewId,reviewId);assert.equal(receipt.operationId,input.operationId);
 const starts=events.filter(e=>e.activityTaskStartedEventAttributes?.scheduledEventId?.toString()===call.eventId!.toString());assert.equal(starts.length,1);assert.equal(starts[0]!.activityTaskStartedEventAttributes!.attempt??1,1);
 assert.equal(events.filter(e=>e.childWorkflowExecutionStartedEventAttributes).length,0);
 const reviews=new PostgresReviews(db),review=await reviews.read(reviewId);assert.ok(review);assert.equal(review.failure.code,'TEXT.CITATION_INVALID');assert.equal(review.failure.executionFact,'executed');
 assert.equal(review.failure.operationId,input.operationId);assert.equal(review.failure.inputFingerprint,input.inputFingerprint);assert.deepEqual(review.observation,observationIdentity(input));assert.equal(review.observation.listingId,'B0GBX7416D');
 assert.equal(review.candidate?.schema,'text-raw-response/1');
 const store=await TextLocalStore.open(c.root+'/text/journal'),key=`text-responses/${input.operationId}.json`,response=await store.read(key,524288,AbortSignal.timeout(10000));assert.ok(response);
 const retained=JSON.parse(Buffer.from(response).toString());assert.deepEqual(retained.input,input);assert.equal(retained.rawResponse,(review.candidate!.value as any).rawResponse);assert.ok(retained.rawResponse.length>0);
 const exec=promisify(execFile);
 const processesAbsent=async()=>{
  const cwd=(await exec('/usr/sbin/lsof',['-a','-u','barry','-d','cwd','-Fn'],{maxBuffer:8*1024*1024})).stdout;
  assert.equal(cwd.split('\n').filter(l=>l===`n${c.codex.workRoot}`||l.startsWith(`n${c.codex.workRoot}/`)).length,0,'OWNED_MODEL_PROCESS_PRESENT');
  const ps=(await exec('/bin/ps',['-axo','pid=,command='],{maxBuffer:8*1024*1024})).stdout;
  assert.ok(!ps.split('\n').some(l=>l.includes(c.codex.workRoot)),'OWNED_MODEL_COMMAND_PRESENT');
  assert.ok(!ps.split('\n').some(l=>/^\s*49517\s/.test(l)),'OLD_WORKER_PRESENT');
  return{checkedAt:new Date().toISOString(),modelWorkRoot:c.codex.workRoot,ownedWorkingDirectoriesAbsent:true,ownedCommandsAbsent:true,oldWorkerPid:49517,oldWorkerAbsent:true};
 };
 const proof={codec:'amazon-citation-pilot-recovery/1',request,namespace:r.namespace,workflowStatus:d.status.name,reviewId,operationId:input.operationId,historySha256:sha256(encode(history)),responseSha256:sha256(response),reviewSha256:sha256(encode(review)),executionEventId:Number(call.eventId),completionEventId:Number(completion.eventId),processProof:await processesAbsent(),reviewPreserved:true};
 await fs.mkdir(out,{recursive:true,mode:0o700});await fs.writeFile(out+'/audit.json',JSON.stringify(proof,null,2),{mode:0o600});
 if(mode==='--release'){
  const prefix=`v3/amazon-history-recovery/${permitId}/`,keep=async(k:string,b:Uint8Array)=>{await remote.store.create(k,b,'application/json',AbortSignal.timeout(30000));assert.deepEqual(await remote.store.read(k,b.length,AbortSignal.timeout(30000)),b);};
  await keep(prefix+'history.json',encode(history));await keep(prefix+'retained-response.json',response);await keep(prefix+'review.json',encode(review));await keep(prefix+'proof.json',encode(proof));
  assert.equal((await h.describe()).status.name,'COMPLETED');assert.deepEqual(await reviews.read(reviewId),review);await processesAbsent();
  await ledger.release(request);assert.equal((await ledger.read(permitId))?.released,true);
  await fs.writeFile(out+'/released.json',JSON.stringify({at:new Date().toISOString(),proofKey:prefix+'proof.json'}),{mode:0o600,flag:'wx'});
 }
 console.log(JSON.stringify({status:mode==='--release'?'released':'recoverable',permitId,reviewId,responseSha256:proof.responseSha256,processProof:proof.processProof,proofKey:mode==='--release'?`v3/amazon-history-recovery/${permitId}/proof.json`:null}));
}finally{await connection.close();await db.end();remote.close();}
