import {proxyActivities,condition} from '@temporalio/workflow';
import {resourceGate} from '../../../packages/v3-product/src/resource-workflow.js';
export async function ResourceStallFixture(queue:string){
 const gate=resourceGate({queue,reviewStopCheck:true,maxWaitSeconds:60,activities:{interpretText:[{resourceId:'model',units:1}],interpretImage:[{resourceId:'model',units:1}]}});
 const a=proxyActivities<{interpretText():Promise<unknown>;interpretImage():Promise<unknown>}>({taskQueue:queue,startToCloseTimeout:'20 seconds',retry:{maximumAttempts:1}});
 let textGranted=false;
 const first=gate('interpretText',binding=>{textGranted=true;return proxyActivities<{interpretText():Promise<unknown>}>({taskQueue:queue,startToCloseTimeout:'20 seconds',retry:{maximumAttempts:1},...binding}).interpretText();});
 void first.catch(()=>{});
 // Temporal may complete concurrent admissions in either order. This scenario
 // specifically tests an already admitted text call blocking the later image.
 await condition(()=>textGranted);
 const results=await Promise.allSettled([first,gate('interpretImage',()=>a.interpretImage())]);
 return results.map(r=>r.status==='fulfilled'?{status:r.status,value:r.value}:{status:r.status,code:r.reason?.type});
}

export async function ResourceFinallyFixture(queue:string){
 const gate=resourceGate({queue,reviewStopCheck:true,maxWaitSeconds:60,activities:{interpretText:[{resourceId:'model',units:1}]}});
 return gate('interpretText',binding=>proxyActivities<{interpretText():Promise<unknown>}>({taskQueue:queue,startToCloseTimeout:'15 seconds',heartbeatTimeout:'3 seconds',retry:{maximumAttempts:1},...binding}).interpretText());
}
