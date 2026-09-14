import {isDeepStrictEqual as equal} from 'node:util';
import {defaultPayloadConverter} from '@temporalio/common';
import {ResourceRequestSchema,type ResourceRequest} from '@crawl-automation/v3-contracts';

type Event={eventId?:unknown;[key:string]:any};
export const historyValue=(raw:any):any=>{
 if(raw?.payloads?.length!==1)throw Error('RESOURCE.RECOVERY_PAYLOAD');const p=raw.payloads[0];
 // Temporal's JSON history format encodes payload bytes as base64. Live RPC
 // histories already contain Uint8Array; support both without changing content.
 return defaultPayloadConverter.fromPayload(typeof p.data==='string'?{data:Buffer.from(p.data,'base64'),metadata:Object.fromEntries(Object.entries(p.metadata??{}).map(([k,v])=>[k,Buffer.from(v as string,'base64')]))}:p);
};
export function historyEffects(events:Event[],name:string){
 const done=new Map(events.filter(e=>e.activityTaskCompletedEventAttributes).map(e=>[String(e.activityTaskCompletedEventAttributes.scheduledEventId),e]));
 return events.filter(e=>e.activityTaskScheduledEventAttributes?.activityType?.name===name).map(e=>({event:e,
  input:historyValue(e.activityTaskScheduledEventAttributes.input),completed:done.get(String(e.eventId)),
  output:done.has(String(e.eventId))?historyValue(done.get(String(e.eventId))!.activityTaskCompletedEventAttributes.result):undefined}));
}
/** A terminal label run plus completed model execution is required; Workflow termination
 * alone is never evidence that a provider stopped. Interleaved OCR is checked too. */
export function stoppedModelReviewChecks(requests:ResourceRequest[],run:{workflowId:string;runId:string;status:string;type:string},events:Event[]){
 const terminal:Record<string,string>={COMPLETED:'workflowExecutionCompletedEventAttributes',FAILED:'workflowExecutionFailedEventAttributes',CANCELLED:'workflowExecutionCanceledEventAttributes',TERMINATED:'workflowExecutionTerminatedEventAttributes',TIMED_OUT:'workflowExecutionTimedOutEventAttributes'};
 if(run.type!=='ChannelStreamingLabelWorkflow'||!terminal[run.status]||!events.at(-1)?.[terminal[run.status]!]||events.some((e,i)=>Number(String(e.eventId))!==i+1))throw Error('RESOURCE.RECOVERY_OWNER_UNCONFIRMED');
 const entry=historyValue(events[0]?.workflowExecutionStartedEventAttributes?.input);
 const started=new Map(events.filter(e=>e.activityTaskStartedEventAttributes).map(e=>[String(e.activityTaskStartedEventAttributes.scheduledEventId),e.activityTaskStartedEventAttributes]));
 const model=[...historyEffects(events,'interpretText'),...historyEffects(events,'interpretImage')];
 for(const effect of [...model,...historyEffects(events,'ocrFile')]){
  if(!effect.completed||(started.get(String(effect.event.eventId))?.attempt??0)!==1)throw Error('RESOURCE.RECOVERY_EXECUTION_UNCONFIRMED');
 }
 const grants=historyEffects(events,'reserveResources'),checks=historyEffects(events,'verifyResourceReviewStopped');
 return requests.map(raw=>{
  const request=ResourceRequestSchema.parse(raw);
  if(request.workflowId!==run.workflowId||request.runId!==run.runId)throw Error('RESOURCE.RECOVERY_IDENTITY');
  const grant=grants.find(g=>equal(g.input,request)&&g.output?.status==='granted'&&g.output.permitId===request.permitId);
  const match=checks.filter(c=>equal(c.input.request,request));
  if(!grant||match.length!==1)throw Error('RESOURCE.RECOVERY_STOP_INTENT');
  const check=match[0]!,rawCheck=check.input,activityName=rawCheck.activityName;
  if(!['interpretText','interpretImage'].includes(activityName)||!equal(request.needs,entry.resources?.activities?.[activityName]))throw Error('RESOURCE.RECOVERY_RESOURCE_MISMATCH');
  const matches=model.filter(m=>m.event.activityTaskScheduledEventAttributes.activityType.name===activityName&&m.output?.status==='review'&&m.output.reviewId===rawCheck.outcome?.reviewId);
  if(matches.length!==1)throw Error('RESOURCE.RECOVERY_MODEL_AMBIGUOUS');
  const effect=matches[0]!;
  if(!equal(effect.output,rawCheck.outcome)||Number(String(effect.event.eventId))<=Number(String(grant.completed!.eventId))||Number(String(effect.completed!.eventId))>=Number(String(check.event.eventId)))throw Error('RESOURCE.RECOVERY_SEQUENCE');
  return{request,check:rawCheck,activityId:effect.event.activityTaskScheduledEventAttributes.activityId,task:effect.input,
   operationId:effect.input.operationId??effect.input.input?.operationId,owner:entry.input.sourcePlan.owner};
 });
}
