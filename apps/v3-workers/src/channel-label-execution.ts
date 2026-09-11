import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import type { QualityReviewStops } from "./quality-review-stops.js";

/** Business retry policy is independent from Codex's internal model turns. */
export async function runChannelLabelActivity(name:string,raw:unknown,stops:Pick<QualityReviewStops,"run">,
  activity:(raw:unknown,signal:AbortSignal)=>Promise<unknown>){
  const context=Context.current(),execution=context.info.workflowExecution;
  if(!execution||context.info.attempt!==1)throw ApplicationFailure.nonRetryable("Inspect retained evidence","CHANNEL.RETRY_DENIED");
  const timer=setInterval(()=>context.heartbeat(),2000);
  try{return await stops.run({...execution,activityId:context.info.activityId},name,raw,()=>activity(raw,context.cancellationSignal));}
  catch{context.cancellationSignal.throwIfAborted();throw ApplicationFailure.nonRetryable("Inspect retained channel evidence","CHANNEL.ACTIVITY_UNRESOLVED");}
  finally{clearInterval(timer);}
}
