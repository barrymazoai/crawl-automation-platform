import { hostname } from "node:os";
import { readFile,writeFile,mkdir } from "node:fs/promises";
import { join,resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import pg from "pg";
import { Client,Connection } from "@temporalio/client";
import { NativeConnection,Worker } from "@temporalio/worker";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { ChannelLabelInputSchema,ChannelSavedLabelWorkflowInputSchema } from "@crawl-automation/v3-contracts";
import { createR2Objects } from "@crawl-automation/v3-artifacts";
import { parseWorkerConfig } from "@crawl-automation/v3-worker-runtime";
import { readGncPrivateJson } from "../src/gnc-config.js";
import { channelLabelActivities } from "../integration/channel-label-activities.js";

async function main(){
  if(process.env.V3_CHANNEL_LABEL_PROOF!=="true"||!/^barrydeMac-mini(?:\.|$)/.test(hostname()))throw Error("MINI_OPT_IN_REQUIRED");
  const [rootArg,browserDirArg,privatePath,runtimePath]=process.argv.slice(2);if(!rootArg||!browserDirArg||!privatePath||!runtimePath)throw Error("PATHS_REQUIRED");
  const root=resolve(rootArg),browserDir=resolve(browserDirArg),base=await readGncPrivateJson(privatePath) as any;
  const runtime=parseWorkerConfig(JSON.parse(await readFile(runtimePath,"utf8"))),browser=JSON.parse(await readFile(join(browserDir,"report.json"),"utf8"));
  if(base.r2.bucket!=="supply-smart-test"||new URL(base.reviewDatabase.connectionString).pathname!=="/crawler_v3_test"||!runtime.namespace.startsWith("batch-a-")||runtime.transport.mode!=="mtls"||
    browser.status!=="passed"||!browser.browserPermitReleased||!browser.coldReadback||browser.products.length!==2||browser.products.some((p:any)=>!p.browserPageClosed)||!/^swanson-browser-[a-f0-9-]{36}$/.test(browser.id))throw Error("TEST_SCOPE_REQUIRED");
  const id=`channel-label-${randomUUID()}`,dir=join(root,id);await mkdir(dir,{mode:0o700});
  const report:Record<string,any>={id,browserProofId:browser.id,status:"running",namespace:runtime.namespace,model:"gpt-5.6-luna",reasoningEffort:"medium",browserCalls:0,
    results:[],startedAt:new Date().toISOString(),deployment:"acceptance-only; per-activity queues in one harness process"};
  const save=()=>writeFile(join(dir,"report.json"),JSON.stringify(report,null,2),{mode:0o600});await save();
  const r2=createR2Objects({...base.r2,prefix:`${base.r2.prefix}/${browser.id}`},base.r2Credentials);
  const db=new pg.Pool({connectionString:base.reviewDatabase.connectionString,ssl:base.reviewDatabase.tls?{rejectUnauthorized:true}:false,max:6,connectionTimeoutMillis:5000,statement_timeout:5000});
  let service:Awaited<ReturnType<typeof channelLabelActivities>>|undefined,connection:Connection|undefined,native:NativeConnection|undefined;
  const workers:Worker[]=[],running:Promise<void>[]=[];
  try{
    service=await channelLabelActivities({root:join(dir,"first"),remote:r2.store,db,storageId:"r2-channel-test/1"});await service.check();
    const inputs=browser.products.map((p:any)=>{
      if(!equal(service!.ocr,p.plan.ocr))throw Error("PROVIDER_CONFIG_MISMATCH");
      // Original acquisition plan stays immutable; this new label operation pins
      // the upgraded image provider independently of the original plan's default.
      return ChannelLabelInputSchema.parse({operationId:`label-${p.listingId}-${id}`,sourcePlan:p.plan,text:service!.text,visionConfigFingerprint:service!.visionFingerprint,corePolicy:"swanson-label-core/1",evidencePolicy:"label-image-first/3"});
    });
    await writeFile(join(dir,"inputs.json"),JSON.stringify(inputs,null,2),{mode:0o600});
    const t=runtime.transport,tls={serverNameOverride:t.serverName,serverRootCACertificate:await readFile(t.caFile),clientCertPair:{crt:await readFile(t.certFile),key:await readFile(t.keyFile)}};
    connection=await Connection.connect({address:runtime.address,tls,connectTimeout:"15 seconds"});native=await NativeConnection.connect({address:runtime.address,tls});
    const client=new Client({connection,namespace:runtime.namespace}),queues=Object.fromEntries(Object.keys(service.route).map(k=>[k,`${id}-${k}`])),resourceQueue=`${id}-resources`;
    const launch=async(options:Parameters<typeof Worker.create>[0])=>{const w=await Worker.create(options);workers.push(w);const run=w.run();run.catch(()=>{});running.push(run);};
    const wrap=(name:string)=>async(raw:unknown)=>{
      const ctx=Context.current(),execution=ctx.info.workflowExecution;if(!execution)throw Error("CHANNEL.WORKFLOW_REQUIRED");if(ctx.info.attempt!==1&&!/^(reserve|release)Resources$/.test(name))throw ApplicationFailure.nonRetryable("Business retry denied","CHANNEL.RETRY_DENIED");
      const timer=setInterval(()=>ctx.heartbeat(),2000),started=Date.now();
      try{const out=await service!.stops.run({workflowId:execution.workflowId,runId:execution.runId,activityId:ctx.info.activityId},name,raw,()=>service!.activities[name]!(raw,ctx.cancellationSignal));console.log(JSON.stringify({event:"ACTIVITY_FINISHED",name,status:(out as any)?.status,ms:Date.now()-started}));return out;}
      catch(error){const code=error instanceof Error&&/^[A-Z0-9_.]+$/.test(error.message)?error.message:"CHANNEL.ACTIVITY_UNRESOLVED";
        console.log(JSON.stringify({event:"ACTIVITY_FAILED",name,code}));throw ApplicationFailure.nonRetryable("Inspect retained evidence",code);}
      finally{clearInterval(timer);}
    };
    const common={connection:native,namespace:runtime.namespace,shutdownGraceTime:"10 seconds" as const};
    for(const [key,name]of Object.entries(service.route))await launch({...common,taskQueue:queues[key]!,activities:{[name]:wrap(name)},maxConcurrentActivityTaskExecutions:key==="ocr"?2:4});
    await launch({...common,taskQueue:resourceQueue,activities:{reserveResources:wrap("reserveResources"),releaseResources:wrap("releaseResources"),verifyResourceReviewStopped:wrap("verifyResourceReviewStopped")}});
    const bundle={codePath:join(root,"channel-label-proof/channel-label-workflows.cjs")};
    await launch({...common,taskQueue:id,workflowBundle:bundle});
    report.workers=workers.length;report.phase="workflow-running";await save();console.log(JSON.stringify({event:"CHANNEL_LABEL_READY",id,report:join(dir,"report.json"),workers:workers.length}));
    const modelNeeds=[{resourceId:"mini-model-account",units:1},{resourceId:"mini-cpu",units:1}];
    const resources={queue:resourceQueue,reviewStopCheck:true,maxWaitSeconds:900,activities:{interpretText:modelNeeds,interpretImage:modelNeeds,ocrFile:[{resourceId:"windows-ocr",units:1}]}};
    const runOne=async(input:any,suffix:string)=>{
      const workflowId=`${id}-${input.sourcePlan.owner.listingId}-${suffix}`;
      const handle=await client.workflow.start("ChannelSavedLabelWorkflow",{workflowId,taskQueue:id,workflowExecutionTimeout:"20 minutes",
        args:[ChannelSavedLabelWorkflowInputSchema.parse({input,queues,resources})]});
      console.log(JSON.stringify({event:"WORKFLOW_STARTED",workflowId}));
      const result=await handle.result(),history=await handle.fetchHistory();
      await Worker.runReplayHistory({workflowBundle:bundle},history);
      await writeFile(join(dir,`${input.sourcePlan.owner.listingId}-${suffix}-history.json`),JSON.stringify(history),{mode:0o600});
      const record=await service!.collection.read(input.operationId);
      const row={workflowId,listingId:input.sourcePlan.owner.listingId,operationId:input.operationId,result,replayPassed:true,registered:!!record};
      if(record)await writeFile(join(dir,`${input.sourcePlan.owner.listingId}-collected.json`),JSON.stringify(record,null,2),{mode:0o600});
      report.results.push(row);await save();console.log(JSON.stringify({event:"PRODUCT_RESULT",...row}));return row;
    };
    // Drain every started handle before closing its shared client. Promise.all
    // rejects on the first cancellation while sibling result() polls stay alive.
    const settled=await Promise.allSettled(inputs.map((i:any)=>runOne(i,"first")));report.providerCalls={...service.counts};
    if(settled.some(r=>r.status==="rejected")){
      report.status="incomplete";report.failedWorkflowCount=settled.filter(r=>r.status==="rejected").length;
      report.phase="workflow-terminal-with-failures";return;
    }
    const first=settled.map(r=>{if(r.status!=="fulfilled")throw Error("WORKFLOW_UNRESOLVED");return r.value;});
    const reviewRows=await db.query("SELECT record->'failure'->>'code' AS code,record->'failure'->>'operationId' AS operation_id FROM public.review_record WHERE record->'failure'->>'requestId'=$1",[browser.id]);
    report.reviews=reviewRows.rows;
    if(first.some(r=>r.result.status!=="collected"||!r.registered)){report.status="review";return;}
    await service.close();service=await channelLabelActivities({root:join(dir,"cold"),remote:r2.store,db,storageId:"r2-channel-test/1",readOnlyProviders:true});
    report.phase="cold-readback";await save();
    const cold=await Promise.all(inputs.map((i:any)=>runOne(i,"cold")));
    if(cold.some((r,index)=>!equal(r.result,first[index]!.result)))throw Error("COLD_RESULT_CONFLICT");
    report.coldProviderCalls={...service.counts};report.status="passed";
  }catch(error){report.status="failed";report.error=error instanceof Error&&/^[A-Z0-9_.]+$/.test(error.message)?error.message:"INSPECT_LOCAL_EVIDENCE";process.exitCode=1;}
  finally{
    report.lastProviderCalls=service?{...service.counts}:null;await service?.close();
    for(const w of workers)if(w.getState()==="RUNNING")w.shutdown();await Promise.allSettled(running);
    await native?.close();await connection?.close();r2.close();await db.end();report.finishedAt=new Date().toISOString();await save();
    console.log(JSON.stringify({event:"CHANNEL_LABEL_FINISHED",report:join(dir,"report.json"),status:report.status,providerCalls:report.providerCalls,error:report.error}));
  }
}
main().catch(()=>{console.error("CHANNEL_LABEL_STARTUP_REJECTED");process.exitCode=1;});
