import { expect,it,vi,beforeEach } from "vitest";
const env=vi.hoisted(()=>({prepare:vi.fn(),inspect:vi.fn(),start:vi.fn(),sleep:vi.fn(),id:"00000000-0000-4000-8000-000000000001"}));
vi.mock("@temporalio/workflow",()=>({proxyActivities:()=>({prepareBrandCollection:env.prepare,inspectBrandCollection:env.inspect}),workflowInfo:()=>({workflowId:`v3-collection-${env.id}`,taskQueue:"brand"}),startChild:env.start,sleep:env.sleep,ParentClosePolicy:{ABANDON:"ABANDON"},WorkflowIdReusePolicy:{REJECT_DUPLICATE:"REJECT_DUPLICATE"},ApplicationFailure:{nonRetryable:(_m:string,c:string)=>Error(c)}}));
import { BrandCollectionWorkflow } from "./brand-workflow.js";
const snapshot={brandId:env.id,brandName:"Brand",sourceId:env.id,sourceRevision:1,channel:"gnc",region:"US",url:"https://www.gnc.com/brands/focus-fuel/"};
beforeEach(()=>{vi.clearAllMocks();env.prepare.mockResolvedValue({catalogQueue:"catalog",catalog:{catalogId:env.id,scope:{brandId:env.id,sourceId:env.id,channel:"gnc",region:"US",rootUrl:snapshot.url,scopeVersion:"v1"},queues:{source:"source",ledger:"ledger",product:"product"}}});env.start.mockResolvedValue({result:async()=>({status:"complete"})});env.inspect.mockResolvedValue({catalogId:env.id,settled:true,catalog:"complete",discovered:1,finished:1});});
it("catalog closure is not root closure while products remain active",async()=>{
  env.inspect.mockResolvedValueOnce({catalogId:env.id,settled:false,catalog:"complete",discovered:1,finished:0});
  const result=await BrandCollectionWorkflow({version:1,requestId:env.id,snapshot});expect(env.sleep).toHaveBeenCalledOnce();expect(result.codec).toBe("brand-collection-settled/1");expect(result.finished).toBe(1);
});
it("wrong scope is rejected before starting catalog",async()=>{
  const plan=await env.prepare();plan.catalog.scope.sourceId="other";env.prepare.mockResolvedValue(plan);
  await expect(BrandCollectionWorkflow({version:1,requestId:env.id,snapshot})).rejects.toThrow("BRAND.IDENTITY");expect(env.start).not.toHaveBeenCalled();
});
