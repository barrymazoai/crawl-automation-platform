import { expect,it,vi } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { RoutedDeliveryCoordinator } from "./routed-coordinator.js";
const id="00000000-0000-4000-8000-000000000001";
const target={clusterId:"test",namespace:"default",workflowType:"BrandCollectionWorkflow",taskQueue:"gnc"};
function fixture(channel="swanson",prior:any=null){
 const submission={requestId:id,snapshot:{brandId:id,brandName:"Test",sourceId:id,sourceRevision:1,channel,region:"US",url:"https://www.swansonvitamins.com/collections/brand-test"}};
 let saved=prior;
 const journal={get:async()=>saved,begin:vi.fn(async(_id:string,t:any)=>{const mayStart=!saved;if(saved&&!isDeepStrictEqual(saved.target,t))throw Error("immutable");saved??={target:t,state:"INTENT"};return{mayStart,receipt:saved};}),record:vi.fn(async()=>saved)};
 const starts=vi.fn(),inspect=vi.fn(async()=>({}));
 const gateway=vi.fn((t:any)=>({target:t,start:starts,inspect}));
 const coordinator=(routes:any)=>new RoutedDeliveryCoordinator({get:async()=>submission} as any,journal as any,routes,gateway as any,target);
 return{coordinator,journal,gateway,starts,inspect};
}
it("routes a new Swanson request once, then only reconciles",async()=>{
 const f=fixture();const c=f.coordinator({gnc:target,swanson:{...target,taskQueue:"swanson"}});
 await c.reconcile(id);await c.reconcile(id);
 expect(f.gateway.mock.calls[0]![0].taskQueue).toBe("swanson");expect(f.starts).toHaveBeenCalledTimes(1);expect(f.inspect).toHaveBeenCalledTimes(2);
});
it("retains an old destination after routes change or disappear",async()=>{
 const f=fixture("swanson",{target:{...target,taskQueue:"old"},state:"CONFIRMED"});
 await f.coordinator({swanson:{...target,taskQueue:"new"}}).reconcile(id);await f.coordinator({}).reconcile(id);
 expect(f.gateway.mock.calls.every(([t])=>t.taskQueue==="old")).toBe(true);expect(f.starts).not.toHaveBeenCalled();
});
it("never falls back to GNC for an unconfigured channel",async()=>{
 const f=fixture();await expect(f.coordinator({gnc:target}).reconcile(id)).rejects.toThrow("CHANNEL_NOT_CONFIGURED");expect(f.gateway).not.toHaveBeenCalled();
});
it("rejects cross-cluster retained receipts without sending Start",async()=>{
 const f=fixture("swanson",{target:{...target,clusterId:"other"},state:"CONFIRMED"});
 await expect(f.coordinator({}).reconcile(id)).rejects.toThrow("CLUSTER_MISMATCH");expect(f.gateway).not.toHaveBeenCalled();
});
it("closed receipts are not started or inspected",async()=>{
 const f=fixture("swanson",{target,state:"CLOSED"});await f.coordinator({}).reconcile(id);expect(f.starts).not.toHaveBeenCalled();expect(f.inspect).not.toHaveBeenCalled();
});
