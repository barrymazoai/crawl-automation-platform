/** Narrow operational recovery for this harness's completed text-quality Review.
 * No reset/resume/retry, no process kill, no arbitrary permit ID or force flag. */
import assert from "node:assert/strict";
import { readFile,writeFile } from "node:fs/promises";
import { join,resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { Client,Connection } from "@temporalio/client";
import { Worker } from "@temporalio/worker";
import { ResourceRequestSchema,observationIdentity,TextInputSchema } from "@crawl-automation/v3-contracts";
import { createR2Objects,RetainedPublication,sha256 } from "@crawl-automation/v3-artifacts";
import { TextLocalStore } from "@crawl-automation/v3-text";
import { PostgresReviews } from "@crawl-automation/v3-review";
import { parseWorkerConfig } from "@crawl-automation/v3-worker-runtime";
import { PostgresResourceAdmission } from "../../../packages/v3-product/src/resource-admission.js";
import { readGncPrivateJson } from "../src/gnc-config.js";
const exec=promisify(execFile);
let stage="preflight";
const decode=(raw:any)=>{assert.equal(raw.payloads.length,1);const p=raw.payloads[0];assert.equal(Buffer.from(p.metadata.encoding).toString(),"json/plain");return JSON.parse(Buffer.from(p.data).toString());};
async function main(){
  assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
  const [rootArg,proofId,privatePath,runtimePath,mode="--audit"]=process.argv.slice(2);
  assert.ok(rootArg&&proofId&&privatePath&&runtimePath);assert.match(proofId,/^channel-label-[a-f0-9-]{36}$/);assert.ok(["--audit","--apply"].includes(mode));
  const root=resolve(rootArg),dir=join(root,proofId),report=JSON.parse(await readFile(join(dir,"report.json"),"utf8"));
  assert.equal(report.id,proofId);assert.ok(["review","failed"].includes(report.status));assert.ok(report.finishedAt);
  const cancelled=report.status==="failed";
  assert.deepEqual(report.lastProviderCalls,cancelled?{ocr:6,text:1,vision:0}:{ocr:0,text:1,vision:0});
  if(!cancelled){assert.equal(report.results.length,2);assert.deepEqual(report.lastProviderCalls,report.providerCalls);}
  const inputs=cancelled?JSON.parse(await readFile(join(dir,"inputs.json"),"utf8")):null;
  if(cancelled)assert.equal(inputs.length,2);
  const ownerWorkflows=cancelled?inputs.map((i:any)=>`${proofId}-${i.sourcePlan.owner.listingId}-first`):report.results.map((r:any)=>r.workflowId);
  assert.equal(new Set(ownerWorkflows).size,2);
  const base=await readGncPrivateJson(privatePath) as any,runtime=parseWorkerConfig(JSON.parse(await readFile(runtimePath,"utf8")));
  assert.equal(base.r2.bucket,"supply-smart-test");assert.equal(new URL(base.reviewDatabase.connectionString).pathname,"/crawler_v3_test");
  assert.equal(runtime.namespace,report.namespace);assert.equal(runtime.transport.mode,"mtls");if(runtime.transport.mode!=="mtls")throw Error();
  // A completed HTTP/Temporal receipt is not by itself an OS process-exit proof.
  async function noOwnedProcesses(){
    const ps=(await exec('/bin/ps',['-axo','pid=,command='],{maxBuffer:4*1024*1024})).stdout;
    assert.ok(!ps.split('\n').some(line=>line.includes(join(root,'channel-label-proof/mini-channel-label-proof.js'))),'Harness still running');
    const cwd=(await exec('/usr/sbin/lsof',['-a','-u',process.env.USER??'barry','-d','cwd','-Fn'],{maxBuffer:8*1024*1024})).stdout;
    const owned=cwd.split('\n').filter(line=>line.startsWith(`n${join(dir,'first/model-work')}/`));
    assert.equal(owned.length,0,'An owned model process is still present');return{checkedAt:new Date().toISOString(),harnessAbsent:true,modelWorkingDirectoriesAbsent:true};
  }
  await noOwnedProcesses();
  const t=runtime.transport,tls={serverNameOverride:t.serverName,serverRootCACertificate:await readFile(t.caFile),clientCertPair:{crt:await readFile(t.certFile),key:await readFile(t.keyFile)}};
  const connection=await Connection.connect({address:runtime.address,tls,connectTimeout:"15 seconds"}),client=new Client({connection,namespace:runtime.namespace});
  const db=new pg.Pool({connectionString:base.reviewDatabase.connectionString,max:2}),ledger=new PostgresResourceAdmission(db),reviews=new PostgresReviews(db);
  const r2=createR2Objects({...base.r2,prefix:`${base.r2.prefix}/${report.browserProofId}`},base.r2Credentials);
  try{
    const terminal=new Map<string,{runId:string;history:any}>(),bundle=join(root,'channel-label-proof/channel-label-workflows.cjs');
    for(const workflowId of ownerWorkflows){
      assert.ok(workflowId.startsWith(`${proofId}-`));
      const h=client.workflow.getHandle(workflowId),d=await h.describe();assert.equal(d.status.name,cancelled?'CANCELLED':'COMPLETED');assert.equal(d.type,'ChannelSavedLabelWorkflow');
      const history=await h.fetchHistory();await Worker.runReplayHistory({workflowBundle:{codePath:bundle}},history);
      terminal.set(workflowId,{runId:d.runId,history});
    }
    const rows=(await db.query("SELECT request FROM resource_permit WHERE request->>'workflowId'=ANY($1::text[]) AND released_at IS NULL",[[...terminal.keys()]])).rows;
    assert.ok(rows.length<=1,'Unexpected extra permits');
    const results=[];
    for(const row of rows){
      const request=ResourceRequestSchema.parse(row.request),run=terminal.get(request.workflowId)!;assert.equal(request.runId,run.runId);
      assert.deepEqual([...request.needs].sort((a,b)=>a.resourceId.localeCompare(b.resourceId)),[{resourceId:'mini-cpu',units:1},{resourceId:'mini-model-account',units:1}]);
      const events=run.history.events as any[],scheduled=events.filter(e=>e.activityTaskScheduledEventAttributes),completed=events.filter(e=>e.activityTaskCompletedEventAttributes);
      const grants=scheduled.filter(e=>e.activityTaskScheduledEventAttributes.activityType.name==='reserveResources'&&decode(e.activityTaskScheduledEventAttributes.input).permitId===request.permitId);
      const grant=grants.find(e=>completed.some(c=>Number(c.activityTaskCompletedEventAttributes.scheduledEventId)===Number(e.eventId)&&decode(c.activityTaskCompletedEventAttributes.result).status==='granted'));
      assert.ok(grant);assert.deepEqual(decode(grant.activityTaskScheduledEventAttributes.input),request);
      const grantCompletion=completed.find(c=>Number(c.activityTaskCompletedEventAttributes.scheduledEventId)===Number(grant.eventId));assert.ok(grantCompletion);
      assert.equal(decode(grantCompletion.activityTaskCompletedEventAttributes.result).permitId,request.permitId);
      const executions=scheduled.filter(e=>['interpretText','interpretImage'].includes(e.activityTaskScheduledEventAttributes.activityType.name));assert.equal(executions.length,1);
      const execution=executions[0],a=execution.activityTaskScheduledEventAttributes;assert.equal(a.activityType.name,'interpretText');assert.ok(Number(execution.eventId)>Number(grant.eventId));
      assert.ok(Number(execution.eventId)>Number(grantCompletion.eventId));
      const task=TextInputSchema.parse(decode(a.input)),completion=completed.find(c=>Number(c.activityTaskCompletedEventAttributes.scheduledEventId)===Number(execution.eventId));assert.ok(completion);
      const started=events.find(e=>Number(e.activityTaskStartedEventAttributes?.scheduledEventId)===Number(execution.eventId));assert.equal(started.activityTaskStartedEventAttributes.attempt??1,1);
      const out=decode(completion.activityTaskCompletedEventAttributes.result);assert.equal(out.status,'review');assert.equal(out.operationId,task.operationId);
      const review=await reviews.read(out.reviewId);assert.ok(review);assert.equal(review.failure.code,'TEXT.LABEL_GROUP_EMPTY');assert.equal(review.failure.executionFact,'executed');
      assert.equal(out.code,review.failure.code);
      assert.equal(review.failure.inputFingerprint,task.inputFingerprint);assert.equal(review.failure.operationId,task.operationId);assert.deepEqual(review.observation,observationIdentity(task));
      const processProof=await noOwnedProcesses(),history=Buffer.from(JSON.stringify(run.history));
      const evidence={codec:'mini-channel-quality-release/1',request,namespace:runtime.namespace,ownerStatus:cancelled?'CANCELLED':'COMPLETED',reviewId:review.reviewId,reviewPreserved:true,
        executionEventId:Number(execution.eventId),completionEventId:Number(completion.eventId),historySha256:sha256(history),bundleSha256:sha256(await readFile(bundle)),processProof};
      // Each verified recovery attempt retains its own evidence; a partial prior
      // publication never needs overwriting or an unsafe force-release path.
      const key=`v3/channel-labels/${proofId}/permit-recovery/${request.permitId}/${randomUUID()}.json`;
      if(mode==='--apply'){
        stage="recovery-local-open";
        const p=new RetainedPublication(await TextLocalStore.open(join(dir,'resource-recovery')),r2.store);
        stage="recovery-history-publication";
        await p.publish(`${key}.history.json`,history,'application/json',AbortSignal.timeout(30000));
        stage="recovery-proof-publication";
        await p.publish(key,Buffer.from(JSON.stringify(evidence)),'application/json',AbortSignal.timeout(30000));
        stage="exact-permit-release";
        await ledger.release(request);assert.equal((await ledger.read(request.permitId))?.released,true);
      }
      results.push({permitId:request.permitId,status:mode==='--apply'?'released-after-proof':'recoverable',reviewId:review.reviewId,executionEventId:evidence.executionEventId,completionEventId:evidence.completionEventId,processProof});
    }
    const output={mode,results,oldReviewsModified:0,providerCalls:0,workflowRestarts:0};
    await writeFile(join(dir,mode==='--apply'?'resource-recovery-applied.json':'resource-recovery-audit.json'),JSON.stringify(output,null,2),{mode:0o600});console.log(JSON.stringify(output));
  }finally{await connection.close();await db.end();r2.close();}
}
main().catch((error)=>{console.error(JSON.stringify({status:'QUALITY_RELEASE_REJECTED_NO_FORCE_RELEASE',stage,
  code:typeof error?.code==='string'&&/^[A-Z0-9_.]+$/.test(error.code)?error.code:'UNCLASSIFIED',
  reason:typeof error?.message==='string'&&/^[A-Z0-9_.]+$/.test(error.message)?error.message:'INSPECT_EVIDENCE'}));process.exitCode=1;});
