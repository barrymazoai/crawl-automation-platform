import { proxyActivities } from "@temporalio/workflow";
import { resourceGate } from "../../../packages/v3-product/src/resource-workflow.js";
export async function ResourceWaitFixture(queue:string){
  const gate=resourceGate({queue,maxWaitSeconds:10,activities:{work:[{resourceId:"isolated-test-cpu",units:1}]}});
  const activity=proxyActivities<{work():Promise<unknown>}>({taskQueue:queue,startToCloseTimeout:"10 seconds",retry:{maximumAttempts:1}});
  return gate("work",()=>activity.work());
}
