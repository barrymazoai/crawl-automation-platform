import {proxyActivities} from '@temporalio/workflow';
import {resourceGate} from '../../../packages/v3-product/src/resource-workflow.js';
export async function ResourceStallFixture(queue:string){
 const gate=resourceGate({queue,reviewStopCheck:true,maxWaitSeconds:60,activities:{interpretText:[{resourceId:'model',units:1}],interpretImage:[{resourceId:'model',units:1}]}});
 const a=proxyActivities<{interpretText():Promise<unknown>;interpretImage():Promise<unknown>}>({taskQueue:queue,startToCloseTimeout:'20 seconds',retry:{maximumAttempts:1}});
 const results=await Promise.allSettled([gate('interpretText',()=>a.interpretText()),gate('interpretImage',()=>a.interpretImage())]);
 return results.map(r=>r.status==='fulfilled'?{status:r.status,value:r.value}:{status:r.status,code:r.reason?.type});
}
