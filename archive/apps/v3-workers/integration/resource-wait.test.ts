import {hostname} from "node:os";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {randomUUID} from "node:crypto";
import {writeFile} from "node:fs/promises";
import {expect,it,vi} from "vitest";
import {TestWorkflowEnvironment} from "@temporalio/testing";
import {Worker} from "@temporalio/worker";

it("Mini: capacity waiting survives the old deadline and Worker restart; recovery executes once; cancellation and unhealthy stay distinct",async()=>{
  expect(hostname()).toMatch(/^barrydeMac-mini(?:\.|$)/);
  const dir=dirname(fileURLToPath(import.meta.url)),bundle=join(dir,"resource-wait-workflows.cjs");
  const env=await TestWorkflowEnvironment.createLocal({server:{ip:"127.0.0.1",ui:false,executable:{type:"cached-download",version:"v1.8.3"}}});
  const queue="resource-wait-"+randomUUID();let mode:"capacity"|"available"|"unhealthy"="capacity",calls=0,releases=0;
  const reservations:{permitId:string;at:number;reason:string}[]=[];
  let worker:Worker|undefined,run:Promise<void>|undefined;
  const boot=async()=>{worker=await Worker.create({connection:env.nativeConnection,taskQueue:queue,workflowBundle:{codePath:bundle},activities:{
    reserveResources:async(r:{permitId:string})=>{reservations.push({permitId:r.permitId,at:Date.now(),reason:mode});return{permitId:r.permitId,status:mode==="available"?"granted":"waiting",reason:mode};},
    releaseResources:async(r:{permitId:string})=>{releases++;return{permitId:r.permitId,status:"released",reason:"released"};},
    work:async()=>{calls++;return{status:"registered"};},
  }});run=worker.run();run.catch(()=>{});};
  const stop=async()=>{if(worker?.getState()==="RUNNING")worker.shutdown();await run;};
  const start=()=>env.client.workflow.start("ResourceWaitFixture",{workflowId:"wait-"+randomUUID(),taskQueue:queue,args:[queue],workflowExecutionTimeout:"3 minutes"});
  try{
    await boot();const h=await start();await vi.waitFor(()=>expect(reservations.length).toBeGreaterThanOrEqual(3),{timeout:35000});
    expect(calls).toBe(0);expect(releases).toBe(0);expect((await h.describe()).status.name).toBe("RUNNING");
    expect(reservations.at(-1)!.at-reservations[0]!.at).toBeGreaterThanOrEqual(19000);
    await stop();await boot();mode="available";expect(await h.result()).toEqual({status:"registered"});expect(calls).toBe(1);expect(releases).toBe(1);
    expect(new Set(reservations.map(r=>r.permitId)).size).toBe(1);
    mode="capacity";let before=reservations.length;const cancel=await start();await vi.waitFor(()=>expect(reservations.length).toBeGreaterThan(before),{timeout:15000});
    await cancel.cancel();await expect(cancel.result()).rejects.toThrow();expect(calls).toBe(1);expect(releases).toBe(1);
    mode="unhealthy";const fault=await start();await expect(fault.result()).rejects.toThrow();expect(calls).toBe(1);expect(releases).toBe(1);
    const history=await fault.fetchHistory();expect(JSON.stringify(history)).toContain("RESOURCE.WAIT_LIMIT");
    for(const handle of [h,cancel,fault])await Worker.runReplayHistory({workflowBundle:{codePath:bundle}},await handle.fetchHistory(),handle.workflowId);
    await writeFile(join(dir,"resource-wait-proof.json"),JSON.stringify({passed:true,at:new Date().toISOString(),providerCalls:0,syntheticBusinessCalls:calls,releases,workerRestart:true,reservations,replays:3},null,2));
  }finally{await stop();await env.teardown();}
},150000);
