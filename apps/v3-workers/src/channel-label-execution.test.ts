import { afterEach,expect,it,vi } from "vitest";
const state=vi.hoisted(()=>({context:null as any}));
vi.mock("@temporalio/activity",()=>({Context:{current:()=>state.context}}));
import { runChannelLabelActivity } from "./channel-label-execution.js";
function setup(){
 vi.useFakeTimers();const controller=new AbortController();
 state.context={info:{workflowExecution:{workflowId:"workflow",runId:"run"},activityId:"activity",attempt:1},heartbeat:vi.fn(),cancellationSignal:controller.signal};
 const stops={run:vi.fn(async(_c:any,_n:any,_r:any,fn:any)=>fn())};return{controller,stops};
}
afterEach(()=>{vi.useRealTimers();});
it("heartbeats while busy and clears the timer after evidence-aware completion",async()=>{
 const f=setup();let finish!:(v:unknown)=>void;
 const work=runChannelLabelActivity("interpretText",{},f.stops,()=>new Promise(r=>{finish=r;}));
 await vi.advanceTimersByTimeAsync(6100);expect(state.context.heartbeat).toHaveBeenCalledTimes(3);
 finish({status:"review"});await expect(work).resolves.toEqual({status:"review"});expect(vi.getTimerCount()).toBe(0);
 expect(f.stops.run.mock.calls[0]![0]).toEqual({workflowId:"workflow",runId:"run",activityId:"activity"});
});
it("denies a business retry before executing any provider",async()=>{
 const f=setup(),fn=vi.fn();state.context.info.attempt=2;
 await expect(runChannelLabelActivity("interpretText",{},f.stops,fn)).rejects.toMatchObject({type:"CHANNEL.RETRY_DENIED",nonRetryable:true});
 expect(fn).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});
it("keeps unknown failures non-retryable and does not leak raw errors",async()=>{
 const f=setup();await expect(runChannelLabelActivity("ocrFile",{},f.stops,async()=>{throw Error("private-credential");})).rejects.toMatchObject({type:"CHANNEL.ACTIVITY_UNRESOLVED",message:"Inspect retained channel evidence",nonRetryable:true});
 expect(vi.getTimerCount()).toBe(0);
});
it("preserves cancellation and always removes its heartbeat",async()=>{
 const f=setup(),reason=Error("cancelled");f.controller.abort(reason);
 await expect(runChannelLabelActivity("interpretImage",{},f.stops,async(_r,s)=>{s.throwIfAborted();})).rejects.toBe(reason);
 expect(vi.getTimerCount()).toBe(0);
});
