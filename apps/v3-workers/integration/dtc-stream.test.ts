import {hostname}from"node:os";import{dirname,join}from"node:path";import{fileURLToPath}from"node:url";import{randomUUID}from"node:crypto";import{writeFile}from"node:fs/promises";
import{expect,it,vi}from"vitest";import{TestWorkflowEnvironment}from"@temporalio/testing";import{Worker}from"@temporalio/worker";import{Context}from"@temporalio/activity";
import{requestDtcControl}from'../src/dtc-temporal-control.js';
import{DtcProductJobSchema}from"@crawl-automation/v3-contracts";
import{channelSavedFixture}from"../../../packages/v3-product/src/channel-saved.fixture.js";
import{sha256,type RetainedPublication}from'@crawl-automation/v3-artifacts';
import{verifyDtcCaptureReview}from'../src/dtc-capture-review.js';

it("Mini: DTC real Temporal per-file streaming, delayed sibling, replay/restart, acquisition failure and cancellation",async()=>{
 expect(hostname()).toMatch(/^barrydeMac-mini(?:\.|$)/);
 const dir=dirname(fileURLToPath(import.meta.url)),bundle=join(dir,"product-workflows.cjs"),proofs:any[]=[];
 const env=await TestWorkflowEnvironment.createLocal({server:{ip:"127.0.0.1",ui:false,executable:{type:"cached-download",version:"v1.8.3"}}});
 try{for(const version of [1,2])for(const mode of ["success","failure","cancel"]){
  const f=await channelSavedFixture(false,"dtc"),p=f.input.sourcePlan,owner=p.owner,id="stream-"+randomUUID(),parentQueue=id+"-parent",labelQueue=id+"-label",browserQueue=id+"-browser";
  const job=DtcProductJobSchema.parse({codec:"dtc-product-job/1",operationId:p.source.producer.operationId,sessionId:p.binding.sessionId,
   discovery:{discoveryId:"discovery-"+id,catalogId:owner.requestId,workflowId:id,scope:{brandId:owner.brandId,sourceId:owner.sourceId,channel:"dtc",region:"US",rootUrl:"https://brand.example/collections/all",scopeVersion:"fixture-1"},entry:{url:p.expectedUrl,kind:"product",listingId:owner.listingId,variantId:owner.variantId},source:p.source},
   queues:{capture:browserQueue,plan:parentQueue,file:browserQueue,label:labelQueue,review:parentQueue},resources:{queue:parentQueue,maxWaitSeconds:10,activities:{browserSession:[{resourceId:"synthetic-browser",units:1}],captureDtcProduct:[{resourceId:"synthetic-model",units:1}]}}});
  const entry={...f.entry,queues:Object.fromEntries(Object.keys(f.entry.queues).map(k=>[k,labelQueue]))};

  const events:{name:string;at:number;operationId?:string|undefined}[]=[],workers:Worker[]=[],runs:Promise<void>[]=[];let closed=false,held=false,fileCalls=0,unblock!:()=>void;
  const pending=new Promise<void>(r=>{unblock=r;}),mark=(name:string,operationId?:string)=>events.push({name,at:Date.now(),operationId});
  const activities=Object.fromEntries(Object.values(f.activityQueues).flatMap(q=>Object.entries(q)).map(([name,fn])=>[name,async(raw:any)=>{mark(name,raw?.operationId);if(name==="collectLabelProduct")expect(closed&&!held).toBe(true);return fn(raw);} ]));
  const spawn=async(queue:string,activities:any)=>{const w=await Worker.create({connection:env.nativeConnection,taskQueue:queue,workflowBundle:{codePath:bundle},activities});workers.push(w);const run=w.run();run.catch(()=>{});runs.push(run);return{w,run};};
  try{
   let label=await spawn(labelQueue,activities);
   const control=async(raw:any)=>{if(version===1)return;const ctx=Context.current();const r=await requestDtcControl({client:env.client,connection:env.connection},ctx.info.workflowExecution!,raw,AbortSignal.timeout(25000));expect(r).toEqual({allowed:true});};
   const ports={
    prepareDtcProduct:async()=>job,captureDtcProduct:async()=>{await control({action:"product",job,model:true});return{job,sourcePlan:p};},
    dtcBrowserControl:async(r:any)=>{expect(Context.current().info.workflowExecution!.workflowId).toBe(id);expect(Context.current().info.workflowType).toBe("DtcCatalogProductV2Workflow");expect(held).toBe(true);expect(r.action).toMatch(/product|file/);mark("mini-control-"+r.action);return{allowed:true};},
    prepareChannelProduct:async()=>({status:"prepared",operationId:p.operationId,inputFingerprint:"a".repeat(64),evidenceKey:"fixture/plan.json",manifest:f.manifest}),
    prepareDtcStreamingLabel:async()=>({job,input:entry}),
    reserveResources:async(r:any)=>{if(r.needs[0].resourceId==="synthetic-model"){expect(held).toBe(true);mark("model-reserve");}else{expect(held).toBe(false);held=true;}return{permitId:r.permitId,status:"granted",reason:"available"};},
    releaseResources:async(r:any)=>{if(r.needs[0].resourceId==="synthetic-model"){expect(closed).toBe(false);expect(held).toBe(true);mark("model-release");}else{expect(closed).toBe(true);held=false;mark("release");}return{permitId:r.permitId,status:"released",reason:"released"};},
    closeDtcProductPage:async()=>{await control({action:"product",job,model:false});closed=true;mark("close");return{taskId:job.sessionId,status:"closed"};},
    acquireDtcFile:async(raw:any)=>{expect(held&&!closed).toBe(true);await control({action:"file",capture:{job,sourcePlan:p},input:raw.input});fileCalls++;mark("file-start",raw.input.operationId);
     if(fileCalls===2){await pending;Context.current().cancellationSignal.throwIfAborted();if(mode==="failure")return{status:"review",operationId:raw.input.operationId,reviewId:"fixture-file-failed",code:"SOURCE.READ_UNRESOLVED",evidenceKey:"fixture/file-failed.json",automaticRetry:false};}
     const r=await f.activities.acquireSourceFile!(raw.input);mark("file-ready",raw.input.operationId);return r;
    },reviewDtcProduct:async()=>({status:"review",operationId:job.operationId,reviewId:"browser-review",code:"DTC.BROWSER_PHASE_UNRESOLVED",evidenceKey:"fixture/browser-review.json",automaticRetry:false}),
   };
   const {captureDtcProduct,closeDtcProductPage,acquireDtcFile,...miniPorts}=ports;await spawn(parentQueue,miniPorts);await spawn(browserQueue,{captureDtcProduct,closeDtcProductPage,acquireDtcFile});
   const h=await env.client.workflow.start(version===2?"DtcCatalogProductV2Workflow":"DtcCatalogProductWorkflow",{workflowId:id,taskQueue:parentQueue,args:[job.discovery],workflowExecutionTimeout:"2 minutes"});
   await vi.waitFor(()=>{expect(fileCalls).toBe(2);expect(f.counts.ocr).toBe(1);expect(f.counts.text).toBe(1);expect(f.visionRecords.size).toBe(1);},{timeout:30000});
   expect(closed).toBe(false);expect(f.collected.size).toBe(0);
   const child=env.client.workflow.getHandle(id+"-label");
   if(mode==="success"){
    const source=f.manifest.sources.find(s=>s.kind==="file-image")!;const r=await f.activities.acquireSourceFile!((source as any).plan.acquire);
    await child.signal("channelSourceReady",{operationId:f.input.operationId,sourceId:source.id,file:r.file});
    label.w.shutdown();await label.run;label=await spawn(labelQueue,activities);
    expect(f.counts.ocr).toBe(1);unblock();expect(await h.result()).toMatchObject({status:"collected"});expect(f.counts.ocr).toBe(2);expect(f.collected.size).toBe(1);expect(held).toBe(false);
   }else if(mode==="failure"){
    unblock();expect(await h.result()).toMatchObject({status:"review",code:"SOURCE.READ_UNRESOLVED"});expect(await child.result()).toMatchObject({status:"review"});expect(held).toBe(true);expect(f.collected.size).toBe(0);expect(f.visionRecords.size).toBe(1);
   }else{
    await h.cancel();unblock();await expect(h.result()).rejects.toThrow();await expect(child.result()).rejects.toThrow();expect(f.collected.size).toBe(0);expect(held).toBe(true);
   }
   expect(closed).toBe(true);expect(fileCalls).toBe(2);
   for(const handle of [h,child]){const history=await handle.fetchHistory();await Worker.runReplayHistory({workflowBundle:{codePath:bundle}},history,handle.workflowId);await writeFile(join(dir,mode+"-"+handle.workflowId+".json"),JSON.stringify(history));}
   proofs.push({version,mode,counts:f.counts,fileCalls,closed,held,events,realProviderCalls:0,realBrowserCalls:0});
  }finally{unblock();for(const w of workers)if(w.getState()==="RUNNING")w.shutdown();await Promise.allSettled(runs);}
 }
 await writeFile(join(dir,"dtc-stream-proof.json"),JSON.stringify({passed:true,at:new Date().toISOString(),proofs,replays:12},null,2));
 }finally{await env.teardown();}
},360000);

it('Mini: returned capture Review verifies stop, releases in order, and preserves quarantine on failure',async()=>{
 expect(hostname()).toMatch(/^barrydeMac-mini(?:\.|$)/);
 const {dtcFixture}=await import('../../../packages/v3-channels/src/dtc-live.fixture.js'),{ApplicationFailure}=await import('@temporalio/common');
 const dir=dirname(fileURLToPath(import.meta.url)),bundle=join(dir,'product-workflows.cjs');
 const env=await TestWorkflowEnvironment.createLocal({server:{ip:'127.0.0.1',ui:false,executable:{type:'cached-download',version:'v1.8.3'}}});
 try{for(const mode of ['verified','unverified','close-unknown']){
  const id='stop-review-'+randomUUID(),base=await dtcFixture().job(),queue=id+'-queue';
  const job=DtcProductJobSchema.parse({...base,discovery:{...base.discovery,workflowId:id},queues:Object.fromEntries(Object.keys(base.queues).map(k=>[k,queue])),resources:{...base.resources,queue}});
  const receipt={status:'capture_review',operationId:job.operationId,url:job.discovery.entry.url,evidenceKey:`v3/dtc-legacy/${job.operationId}/capture-stop.json`,evidenceSha256:'a'.repeat(64)};
  const held=new Set<string>(),events:string[]=[],objects=new Map<string,Buffer>();
  const publication={remote:{read:async(key:string)=>objects.get(key)??null}} as unknown as RetainedPublication;
  const worker=await Worker.create({connection:env.nativeConnection,taskQueue:queue,workflowBundle:{codePath:bundle},activities:{
   prepareDtcProduct:async()=>job,
   reserveResources:async(r:any)=>{held.add(r.permitId);return {permitId:r.permitId,status:'granted',reason:'available'};},
   releaseResources:async(r:any)=>{events.push(r.needs[0].resourceId==='model'?'model-release':'browser-release');held.delete(r.permitId);return {permitId:r.permitId,status:'released',reason:'released'};},
   captureDtcProduct:async()=>{
    const {workflowId,runId}=Context.current().info.workflowExecution!,result={status:'needs_review',reasonCode:'missing_html_evidence',summary:'partial fixture'},resultBytes=Buffer.from(JSON.stringify(result));
    const proof=Buffer.from(JSON.stringify({version:'dtc-capture-stop/1',operationId:job.operationId,url:job.discovery.entry.url,execution:{workflowId,runId:mode==='unverified'?randomUUID():runId},runnerExitCode:0,closure:{taskId:job.sessionId,targetId:'TARGET',status:'closed'},result,resultSha256:sha256(resultBytes),files:[]}));
    objects.set(`v3/dtc-legacy/${job.operationId}/result.json`,resultBytes);objects.set(receipt.evidenceKey,proof);receipt.evidenceSha256=sha256(proof);return receipt;
   },
   verifyDtcCaptureReview:async()=>{
    expect(held.size).toBe(2);events.push('verify');const execution=Context.current().info.workflowExecution!;
    // Exercise the real SDK protobuf instance that production Activities receive.
    expect(Object.getPrototypeOf(execution)).not.toBe(Object.prototype);
    try{return await verifyDtcCaptureReview(job,receipt,execution,publication,Context.current().cancellationSignal);}
    catch(error){throw ApplicationFailure.nonRetryable(String(error),'DTC.CAPTURE_STOP_UNVERIFIED');}
   },
   closeDtcProductPage:async()=>{events.push('close');return {taskId:job.sessionId,status:mode==='close-unknown'?'pending':'closed'};},
   reviewDtcProduct:async(raw:any)=>({status:'review',operationId:job.operationId,reviewId:'fixture-review',code:raw.code,evidenceKey:'fixture/review.json',automaticRetry:false}),
  }});
  const h=await env.client.workflow.start('DtcCatalogProductV2Workflow',{workflowId:id,taskQueue:queue,args:[job.discovery],workflowExecutionTimeout:'1 minute'});
  const outcome=await worker.runUntil(h.result());
  expect(outcome).toMatchObject({status:'review',code:mode==='verified'?'DTC.CAPTURE_INCOMPLETE':'DTC.BROWSER_PHASE_UNRESOLVED'});
  expect(held.size).toBe(mode==='verified'?0:mode==='unverified'?2:1);
  if(mode==='verified')expect(events).toEqual(['verify','model-release','close','browser-release']);
  const history=await h.fetchHistory();await Worker.runReplayHistory({workflowBundle:{codePath:bundle}},history,id);
  await writeFile(join(dir,id+'.json'),JSON.stringify(history));
 }}finally{await env.teardown();}
},120000);
