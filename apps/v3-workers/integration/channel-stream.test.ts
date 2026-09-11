import {hostname}from"node:os";import{dirname,join}from"node:path";import{fileURLToPath}from"node:url";import{randomUUID}from"node:crypto";import{writeFile}from"node:fs/promises";
import{expect,it,vi}from"vitest";import{TestWorkflowEnvironment}from"@temporalio/testing";import{Worker}from"@temporalio/worker";import{Context}from"@temporalio/activity";
import{SwansonProductJobSchema}from"@crawl-automation/v3-contracts";
import{channelSavedFixture}from"../../../packages/v3-product/src/channel-saved.fixture.js";

it("Mini: real Temporal per-file streaming, delayed sibling, replay/restart, acquisition failure and cancellation",async()=>{
 expect(hostname()).toMatch(/^barrydeMac-mini(?:\.|$)/);
 const dir=dirname(fileURLToPath(import.meta.url)),bundle=join(dir,"product-workflows.cjs"),proofs:any[]=[];
 const env=await TestWorkflowEnvironment.createLocal({server:{ip:"127.0.0.1",ui:false,executable:{type:"cached-download",version:"v1.8.3"}}});
 try{for(const mode of ["success","failure","cancel"]){
  const f=await channelSavedFixture(false),p=f.input.sourcePlan,owner=p.owner,id="stream-"+randomUUID(),parentQueue=id+"-parent",labelQueue=id+"-label";
  const job=SwansonProductJobSchema.parse({codec:"swanson-product-job/1",operationId:p.source.producer.operationId,sessionId:p.binding.sessionId,
   discovery:{discoveryId:"discovery-"+id,catalogId:owner.requestId,workflowId:id,scope:{brandId:owner.brandId,sourceId:owner.sourceId,channel:"swanson",region:"US",rootUrl:"https://www.swansonvitamins.com/collections/brand-synthetic",scopeVersion:"fixture-1"},entry:{url:p.expectedUrl,kind:"family",listingId:"synthetic",variantId:null},source:p.source},
   queues:{capture:parentQueue,plan:parentQueue,file:parentQueue,label:labelQueue,review:parentQueue},resources:{queue:parentQueue,maxWaitSeconds:10,activities:{browserSession:[{resourceId:"synthetic-browser",units:1}]}}});
  const entry={...f.entry,queues:Object.fromEntries(Object.keys(f.entry.queues).map(k=>[k,labelQueue]))};
  const family={...job.discovery,discoveryId:"family-"+id,workflowId:"family-"+id};
  job.familyDiscovery=family;job.discovery.entry={...job.discovery.entry,kind:"product",variantId:owner.variantId};
  const events:{name:string;at:number;operationId?:string|undefined}[]=[],workers:Worker[]=[],runs:Promise<void>[]=[];let closed=false,held=false,fileCalls=0,unblock!:()=>void;
  const pending=new Promise<void>(r=>{unblock=r;}),mark=(name:string,operationId?:string)=>events.push({name,at:Date.now(),operationId});
  const activities=Object.fromEntries(Object.values(f.activityQueues).flatMap(q=>Object.entries(q)).map(([name,fn])=>[name,async(raw:any)=>{mark(name,raw?.operationId);if(name==="collectLabelProduct")expect(closed&&!held).toBe(true);return fn(raw);} ]));
  const spawn=async(queue:string,activities:any)=>{const w=await Worker.create({connection:env.nativeConnection,taskQueue:queue,workflowBundle:{codePath:bundle},activities});workers.push(w);const run=w.run();run.catch(()=>{});runs.push(run);return{w,run};};
  try{
   let label=await spawn(labelQueue,activities);
   await spawn(parentQueue,{
    prepareSwansonVariantProduct:async()=>job,captureSwansonProduct:async()=>({job,sourcePlan:p}),
    prepareChannelProduct:async()=>({status:"prepared",operationId:p.operationId,inputFingerprint:"a".repeat(64),evidenceKey:"fixture/plan.json",manifest:f.manifest}),
    prepareSwansonStreamingLabel:async()=>({job,input:entry}),
    reserveResources:async(r:any)=>{expect(held).toBe(false);held=true;return{permitId:r.permitId,status:"granted",reason:"available"};},
    releaseResources:async(r:any)=>{expect(closed).toBe(true);held=false;mark("release");return{permitId:r.permitId,status:"released",reason:"released"};},
    closeSwansonProductPage:async()=>{closed=true;mark("close");return{taskId:job.sessionId,status:"closed"};},
    acquireSwansonFile:async(raw:any)=>{expect(held&&!closed).toBe(true);fileCalls++;mark("file-start",raw.input.operationId);
     if(fileCalls===2){await pending;Context.current().cancellationSignal.throwIfAborted();if(mode==="failure")return{status:"review",operationId:raw.input.operationId,reviewId:"fixture-file-failed",code:"SOURCE.READ_UNRESOLVED",evidenceKey:"fixture/file-failed.json",automaticRetry:false};}
     const r=await f.activities.acquireSourceFile!(raw.input);mark("file-ready",raw.input.operationId);return r;
    },reviewSwansonProduct:async()=>({status:"review",operationId:job.operationId,reviewId:"browser-review",code:"SWANSON.BROWSER_PHASE_UNRESOLVED",evidenceKey:"fixture/browser-review.json",automaticRetry:false}),
   });
   const h=await env.client.workflow.start("SwansonVariantProductWorkflow",{workflowId:id,taskQueue:parentQueue,args:[{family,discovery:job.discovery}],workflowExecutionTimeout:"2 minutes"});
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
   proofs.push({mode,counts:f.counts,fileCalls,closed,held,events,realProviderCalls:0,realBrowserCalls:0});
  }finally{unblock();for(const w of workers)if(w.getState()==="RUNNING")w.shutdown();await Promise.allSettled(runs);}
 }
 await writeFile(join(dir,"channel-stream-proof.json"),JSON.stringify({passed:true,at:new Date().toISOString(),proofs,replays:6},null,2));
 }finally{await env.teardown();}
},240000);
