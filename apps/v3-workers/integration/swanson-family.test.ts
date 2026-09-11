import {hostname} from "node:os";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {writeFile} from "node:fs/promises";
import {expect,it,vi} from "vitest";
import {TestWorkflowEnvironment} from "@temporalio/testing";
import {Worker} from "@temporalio/worker";
import {swansonLiveFixture} from "../../../packages/v3-channels/src/swanson-live.fixture.js";
import {SwansonFamilies} from "../../../packages/v3-channels/src/swanson-family.js";
import {SwansonProductJobs} from "../../../packages/v3-product/src/swanson-product-jobs.js";
it("Mini: two overlapping families publish two global SKUs, survive Worker restart and family cancellation",async()=>{
 expect(hostname()).toMatch(/^barrydeMac-mini(?:\.|$)/);
 const dir=dirname(fileURLToPath(import.meta.url)),bundle={codePath:join(dir,"family-proof-workflows.cjs")},f=swansonLiveFixture(),raw=await f.job();
 const ds=[raw.discovery,{...raw.discovery,discoveryId:"family-two",workflowId:"family-two"}],records=new Map(ds.map(d=>[d.discoveryId,d])),q="family-proof";
 const policy={scope:f.scope,queues:{...raw.queues,capture:q,review:q},resources:{queue:q,maxWaitSeconds:10,activities:{browserSession:[{resourceId:"browser",units:1}]}}};
 const jobs=new SwansonProductJobs({query:async(_s,a)=>({rows:records.has(a?.[0] as string)?[{record:records.get(a![0] as string)}]:[],rowCount:1})},f.publication,policy);
 const p={...f.product,variantPicker:{unmapped:0,options:[{group:"Size",label:"first",url:f.product.canonicalUrl,variantId:f.product.selectedForms[0].variantIds[0],selected:true,available:true},{group:"Size",label:"second",url:"https://www.swansonvitamins.com/p/second-size",variantId:"999",selected:false,available:true}]}};
 let captures=0,held=false;const families=new SwansonFamilies(f.publication,{capture:async(_j,_s,retain)=>{captures++;await retain(p);return p;}});
 const env=await TestWorkflowEnvironment.createLocal({server:{ip:"127.0.0.1",ui:false,executable:{type:"cached-download",version:"v1.8.3"}}}),runs:Promise<void>[]=[],workers:Worker[]=[];
 const activity={prepareSwansonProduct:(d:any)=>jobs.prepare(d,d.workflowId,AbortSignal.timeout(5000)),enumerateSwansonFamily:(j:any)=>families.capture(j,AbortSignal.timeout(5000)),
  prepareSwansonFamilyProducts:async(j:any)=>{const r=await families.inspect(j,AbortSignal.timeout(5000));return Promise.all(r!.discoveries.map(discovery=>jobs.prepareVariant({family:j.discovery,discovery},AbortSignal.timeout(5000))));},
  inspectSwansonFamilyProducts:async(j:any)=>{const r=await families.inspect(j,AbortSignal.timeout(5000)),states=[];for(const d of r!.discoveries){try{const w=await env.client.workflow.getHandle(d.workflowId).describe();states.push({workflowId:d.workflowId,status:w.status.name,held:false});}catch{states.push({workflowId:d.workflowId,status:"PENDING",held:false});}}return{coverage:r!.coverage,states};},
  reserveResources:async(r:any)=>{if(held)return{permitId:r.permitId,status:"waiting",reason:"capacity"};held=true;return{permitId:r.permitId,status:"granted",reason:"available"};},
  releaseResources:async(r:any)=>{held=false;return{permitId:r.permitId,status:"released",reason:"released"};},
 };
 const spawn=async()=>{const w=await Worker.create({connection:env.nativeConnection,taskQueue:q,workflowBundle:bundle,activities:activity});workers.push(w);const run=w.run();run.catch(()=>{});runs.push(run);return{w,run};};
 const handles:any[]=[];
 try{let worker=await spawn();
  for(const d of ds)handles.push(await env.client.workflow.start("SwansonCatalogProductWorkflow",{workflowId:d.workflowId,taskQueue:q,args:[d],workflowExecutionTimeout:"2 minutes"}));
  await vi.waitFor(async()=>{const children=[];for await(const w of env.client.workflow.list())if(w.type==="SwansonVariantProductWorkflow")children.push(w);expect(children).toHaveLength(2);expect(captures).toBe(2);},{timeout:30000});
  worker.w.shutdown();await worker.run;worker=await spawn();
  await handles[0].cancel();await expect(handles[0].result()).rejects.toThrow();
  const first=await jobs.prepare(ds[0],ds[0]!.workflowId,AbortSignal.timeout(5000)),r=await families.inspect(first,AbortSignal.timeout(5000));
  for(const d of r!.discoveries){const h=env.client.workflow.getHandle(d.workflowId);expect((await h.describe()).status.name).toBe("RUNNING");await h.signal("finish");await h.result();handles.push(h);}
  expect(await handles[1].result()).toMatchObject({status:"completed",variants:2});expect(captures).toBe(2);expect(held).toBe(false);
  for(const h of handles){const history=await h.fetchHistory();await Worker.runReplayHistory({workflowBundle:bundle},history,h.workflowId);}
  await writeFile(join(dir,"family-proof.json"),JSON.stringify({passed:true,captures,globalSkus:2,families:2,workerRestart:true,cancelledFamilyDidNotCancelSharedSku:true,replays:handles.length,realProviderCalls:0},null,2));
 }finally{for(const w of workers)if(w.getState()==="RUNNING")w.shutdown();await Promise.allSettled(runs);await env.teardown();}
},120000);
