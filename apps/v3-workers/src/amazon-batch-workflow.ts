import {proxyActivities,workflowInfo,defineQuery,defineSignal,setHandler,condition,sleep,continueAsNew,isCancellation,ApplicationFailure} from '@temporalio/workflow';
import {AmazonBatchInputSchema,type AmazonBatchActivities,type BatchReport} from './amazon-batch-contract.js';

export const amazonBatchProgress=defineQuery<unknown>('progress');
export const pauseAmazonBatch=defineSignal('pause');
export const resumeAmazonBatch=defineSignal('resume');

/** Temporal owns the durable cursor, waits, pause/resume and bounded continuation.
 * Activities use the normal Brand intake; existing product workflows stay intact. */
export async function AmazonHistoryBatchWorkflow(raw:unknown):Promise<unknown>{
 const input=AmazonBatchInputSchema.parse(raw);
 if(workflowInfo().workflowId!==input.campaignId)throw ApplicationFailure.nonRetryable('Batch identity conflict','AMAZON.BATCH_IDENTITY');
 const call={campaignId:input.campaignId,manifestSha256:input.manifestSha256};
 const a=proxyActivities<AmazonBatchActivities>({taskQueue:input.controlQueue,startToCloseTimeout:'3 minutes',scheduleToCloseTimeout:'6 minutes',heartbeatTimeout:'30 seconds',retry:{maximumAttempts:3,initialInterval:'5 seconds',maximumInterval:'20 seconds'}});
 let paused=false,completedThisRun=0;
 const state={campaignId:input.campaignId,phase:'starting',cursor:input.cursor,totalChunks:0,totalProducts:0,requestId:null as string|null,workflowId:null as string|null,error:null as string|null,report:null as BatchReport|null};
 setHandler(amazonBatchProgress,()=>state);
 setHandler(pauseAmazonBatch,()=>{paused=true;state.phase='paused';});
 setHandler(resumeAmazonBatch,()=>{paused=false;state.error=null;state.phase='running';});
 for(;;){
  try{
   await condition(()=>!paused);
   const plan=await a.loadAmazonHistoryBatch(call);state.totalChunks=plan.requestIds.length;state.totalProducts=plan.totalProducts;
   if(state.cursor>plan.requestIds.length)throw ApplicationFailure.nonRetryable('Invalid cursor','AMAZON.BATCH_CURSOR');
   while(state.cursor<plan.requestIds.length){
    await condition(()=>!paused);state.phase='running';state.requestId=plan.requestIds[state.cursor]!;
    const chunk={...call,requestId:state.requestId};
    const accepted=await a.submitAmazonHistoryChunk(chunk);
    if(!accepted.accepted){state.phase='waiting-for-capacity';await sleep('30 seconds');continue;}
    state.workflowId=accepted.workflowId;
    for(;;){
     const result=await a.inspectAmazonHistoryChunk(chunk);state.report=await a.reportAmazonHistoryBatch(call);
     if(result.settled)break;
     state.phase=paused?'paused':'waiting-for-products';
     await a.recoverAmazonHistoryChunk(chunk);
     await sleep('30 seconds');
    }
    state.cursor++;completedThisRun++;
    if(completedThisRun>=20&&state.cursor<plan.requestIds.length){
     break;
    }
   }
   if(state.cursor===plan.requestIds.length){state.phase='complete';state.requestId=null;state.workflowId=null;state.report=await a.reportAmazonHistoryBatch(call);return state;}
  }catch(error){
   if(isCancellation(error))throw error;
   // A failed RPC is never permission to skip a chunk or invent a new request.
   state.error=error instanceof Error?error.message.slice(0,500):'AMAZON.BATCH_CONTROL_UNVERIFIED';state.phase='blocked';paused=true;
   await condition(()=>!paused);
  }
  // ContinueAsNew throws a control-flow exception; keep it outside the recovery catch.
  if(completedThisRun>=20){await condition(()=>!paused);return continueAsNew<typeof AmazonHistoryBatchWorkflow>({...input,cursor:state.cursor});}
 }
}
