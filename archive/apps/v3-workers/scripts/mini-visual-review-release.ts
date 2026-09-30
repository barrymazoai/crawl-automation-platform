/** Exact failed acceptance recovery: preserve Review; prove model exit, do not resume or register it. */
import assert from "node:assert/strict";
import {readFile,writeFile} from "node:fs/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {hostname} from "node:os";
import {join} from "node:path";
import pg from "pg";
import {Connection,Client} from "@temporalio/client";
import {Worker} from "@temporalio/worker";
import {ResourceRequestSchema,VisionTaskSchema} from "@crawl-automation/v3-contracts";
import {createR2Objects,RetainedPublication,sha256} from "@crawl-automation/v3-artifacts";
import {TextLocalStore} from "@crawl-automation/v3-text";
import {visionFingerprint} from "@crawl-automation/v3-vision";
import {PostgresReviews} from "@crawl-automation/v3-review";
import {PostgresResourceAdmission} from "../../../packages/v3-product/src/resource-admission.js";
import {readGncPrivateJson} from "../src/gnc-config.js";
const exec=promisify(execFile),decode=(p:any)=>{assert.equal(p.payloads.length,1);assert.equal(Buffer.from(p.payloads[0].metadata.encoding).toString(),"json/plain");return JSON.parse(Buffer.from(p.payloads[0].data).toString())};
async function main(){
 assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);const[privatePath,runtimePath,mode="--audit"]=process.argv.slice(2);assert.ok(privatePath&&runtimePath);assert.ok(["--audit","--apply"].includes(mode));
 const root="/Users/barry/apps/crawlv3-channel-restored.PCrTm6/quality-batch-3",id="visual-quality-ade3b034-e790-4a2a-a983-e8878e712f08",dir=join(root,id),report=JSON.parse(await readFile(join(dir,"report.json"),"utf8"));assert.equal(report.status,"failed");assert.ok(report.finishedAt);
 const base=await readGncPrivateJson(privatePath) as any,runtime=JSON.parse(await readFile(runtimePath,"utf8")),t=runtime.transport;assert.equal(new URL(base.reviewDatabase.connectionString).pathname,"/crawler_v3_test");assert.equal(base.r2.bucket,"supply-smart-test");
 const noProcesses=async()=>{const ps=(await exec("/bin/ps",["-axo","pid=,command="])).stdout;assert.ok(!ps.split("\n").some(s=>s.includes(join(root,"channel-label-proof/mini-visual-quality-proof.js"))));const cwd=(await exec("/usr/sbin/lsof",["-a","-u","barry","-d","cwd","-Fn"],{maxBuffer:8388608})).stdout;assert.ok(!cwd.split("\n").some(s=>s.startsWith(`n${dir}/first/model-work/`)));return{harnessAbsent:true,modelCwdAbsent:true,at:new Date().toISOString()}};
 await noProcesses();const db=new pg.Pool({connectionString:base.reviewDatabase.connectionString}),ledger=new PostgresResourceAdmission(db),reviews=new PostgresReviews(db),r2=createR2Objects({...base.r2,prefix:`${base.r2.prefix}/${report.browserProofId}`},base.r2Credentials);
 const connection=await Connection.connect({address:runtime.address,tls:{serverNameOverride:t.serverName,serverRootCACertificate:await readFile(t.caFile),clientCertPair:{crt:await readFile(t.certFile),key:await readFile(t.keyFile)}}});
 try{
  const client=new Client({connection,namespace:runtime.namespace}),workflowId=`${id}-8572156018826-vision`,h=client.workflow.getHandle(workflowId),d=await h.describe();assert.equal(d.status.name,"COMPLETED");assert.equal(d.type,"VisionQualityProbe");
  const history=await h.fetchHistory();await Worker.runReplayHistory({workflowBundle:{codePath:join(root,"channel-label-proof/channel-label-workflows.cjs")}},history);
  const rows=(await db.query("SELECT request FROM resource_permit WHERE request->>'workflowId'=$1 AND released_at IS NULL",[workflowId])).rows;assert.ok(rows.length<=1);
  const results=[];
  for(const row of rows){
   const request=ResourceRequestSchema.parse(row.request);assert.equal(request.runId,d.runId);assert.deepEqual(request.needs.map(n=>n.resourceId).sort(),["mini-cpu","mini-model-account"]);
   const events=history.events as any[],scheduled=events.filter(e=>e.activityTaskScheduledEventAttributes),completions=events.filter(e=>e.activityTaskCompletedEventAttributes);
   const executions=scheduled.filter(e=>e.activityTaskScheduledEventAttributes.activityType.name==="interpretImage");assert.equal(executions.length,1);const e=executions[0],task=VisionTaskSchema.parse(decode(e.activityTaskScheduledEventAttributes.input));assert.equal(task.input.operationId,`${id}-8572156018826-vision`);
   const grant=scheduled.find(e=>e.activityTaskScheduledEventAttributes.activityType.name==="reserveResources"&&decode(e.activityTaskScheduledEventAttributes.input).permitId===request.permitId);assert.ok(grant);assert.deepEqual(decode(grant.activityTaskScheduledEventAttributes.input),request);
   const granted=completions.find(c=>Number(c.activityTaskCompletedEventAttributes.scheduledEventId)===Number(grant.eventId));assert.equal(decode(granted.activityTaskCompletedEventAttributes.result).status,"granted");assert.ok(Number(e.eventId)>Number(granted.eventId));
   const completed=completions.find(c=>Number(c.activityTaskCompletedEventAttributes.scheduledEventId)===Number(e.eventId));assert.ok(completed);const started=events.find(s=>Number(s.activityTaskStartedEventAttributes?.scheduledEventId)===Number(e.eventId));assert.equal(started.activityTaskStartedEventAttributes.attempt??1,1);
   const out=decode(completed.activityTaskCompletedEventAttributes.result),review=await reviews.read(out.reviewId);assert.ok(review);assert.equal(out.code,"VISION.HANDOFF_PENDING");assert.equal(review.failure.code,out.code);assert.equal(review.failure.executionFact,"executed");assert.equal(review.failure.inputFingerprint,visionFingerprint(task));assert.deepEqual(review.observation,task.input.selection.observation);
   const bytes=await r2.store.read(review.failure.evidenceKey!,2097152,AbortSignal.timeout(30000));assert.ok(bytes);const response=JSON.parse(Buffer.from(bytes).toString());assert.equal(response.sha256,sha256(Buffer.from(response.raw)));assert.equal(response.fingerprint,visionFingerprint(task));
   const processProof=await noProcesses(),proof={codec:"visual-review-release/1",request,reviewId:review.reviewId,reviewPreserved:true,historySha256:sha256(Buffer.from(JSON.stringify(history))),rawSha256:response.sha256,processProof};
   if(mode==="--apply"){const pub=new RetainedPublication(await TextLocalStore.open(join(dir,"release-journal")),r2.store),key=`v3/visual-quality-recovery/${request.permitId}`;await pub.publish(`${key}/history.json`,Buffer.from(JSON.stringify(history)),"application/json",AbortSignal.timeout(30000));await pub.publish(`${key}/${Date.now()}.json`,Buffer.from(JSON.stringify(proof)),"application/json",AbortSignal.timeout(30000));await ledger.release(request);assert.equal((await ledger.read(request.permitId))?.released,true);}
   results.push({permitId:request.permitId,status:mode==="--apply"?"released":"recoverable",proof});
  }
  const output={mode,results,providerCalls:0,reviewChanges:0,registrations:0};await writeFile(join(dir,mode==="--apply"?"release-applied.json":"release-audit.json"),JSON.stringify(output,null,2),{mode:0o600});console.log(JSON.stringify(output));
 }finally{await db.end();await connection.close();r2.close();}
}
main().catch(()=>{console.error("VISUAL_REVIEW_RELEASE_REJECTED");process.exitCode=1});
