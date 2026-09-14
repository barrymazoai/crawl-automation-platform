import {expect,it} from 'vitest';
import {defaultPayloadConverter} from '@temporalio/common';
import {stoppedModelReviewChecks} from './stopped-model-recovery.js';
function fixture(){
 const run={workflowId:'product-label',runId:'00000000-0000-4000-8000-000000000001',type:'ChannelStreamingLabelWorkflow',status:'TERMINATED'},request={...run,permitId:'permit-1',needs:[{resourceId:'model',units:1}]};
 const r={permitId:request.permitId,workflowId:run.workflowId,runId:run.runId,needs:request.needs},outcome={status:'review',operationId:'op',reviewId:'review-1',code:'TEXT.LABEL_GROUP_EMPTY'};
 const payload=(x:unknown)=>({payloads:[defaultPayloadConverter.toPayload(x)]});
 const events:any[]=[
  {workflowExecutionStartedEventAttributes:{input:payload({resources:{activities:{interpretText:r.needs}},input:{sourcePlan:{owner:{requestId:'request'}}}})}},
  {activityTaskScheduledEventAttributes:{activityType:{name:'reserveResources'},activityId:'grant',input:payload(r)}},
  {activityTaskStartedEventAttributes:{scheduledEventId:2,attempt:1}},
  {activityTaskCompletedEventAttributes:{scheduledEventId:2,result:payload({permitId:r.permitId,status:'granted',reason:'available'})}},
  {activityTaskScheduledEventAttributes:{activityType:{name:'interpretText'},activityId:'model',input:payload({operationId:'op'})}},
  {activityTaskStartedEventAttributes:{scheduledEventId:5,attempt:1}},
  {activityTaskCompletedEventAttributes:{scheduledEventId:5,result:payload(outcome)}},
  {activityTaskScheduledEventAttributes:{activityType:{name:'verifyResourceReviewStopped'},activityId:'stop',input:payload({request:r,activityName:'interpretText',outcome})}},
  {activityTaskStartedEventAttributes:{scheduledEventId:8,attempt:1}},
  {activityTaskFailedEventAttributes:{scheduledEventId:8}},
  {workflowExecutionTerminatedEventAttributes:{reason:'history limit'}}
 ].map((e,i)=>({eventId:i+1,...e}));
 return{run,request:r,events};
}
it('plans recovery for a completed quality Review in a terminated label run',()=>{
 const f=fixture(),checks=stoppedModelReviewChecks([f.request],f.run,f.events);expect(checks).toHaveLength(1);expect(checks[0]).toMatchObject({activityId:'model',operationId:'op',check:{outcome:{reviewId:'review-1'}}});
});
it('accepts archived Temporal JSON payloads without changing the recovery plan',()=>{
 const f=fixture();const archived=JSON.parse(JSON.stringify(f.events,(_k,v)=>v instanceof Uint8Array?Buffer.from(v).toString('base64'):v));
 expect(stoppedModelReviewChecks([f.request],f.run,archived)).toEqual(stoppedModelReviewChecks([f.request],f.run,f.events));
});
it.each(['running','missing-completion','retried-model','foreign-run','wrong-resource','missing-history'])('quarantines %s even if the workflow was terminated',mode=>{
 const f=fixture();if(mode==='running')f.run.status='RUNNING';if(mode==='missing-completion')f.events[6]={eventId:7,activityTaskTimedOutEventAttributes:{scheduledEventId:5}};
 if(mode==='retried-model')f.events[5].activityTaskStartedEventAttributes.attempt=2;if(mode==='foreign-run')f.request.runId='00000000-0000-4000-8000-000000000002';
 if(mode==='wrong-resource')f.request.needs=[{resourceId:'browser',units:1}];if(mode==='missing-history')f.events.splice(3,1);
 expect(()=>stoppedModelReviewChecks([f.request],f.run,f.events)).toThrow();
});
