import {proxyActivities,workflowInfo,defineQuery,defineSignal,setHandler,condition,sleep,continueAsNew,isCancellation,ApplicationFailure,patched} from '@temporalio/workflow';
import {AmazonBatchInputSchema,type AmazonBatchActivities,type BatchReport} from './amazon-batch-contract.js';

export const amazonBatchProgress=defineQuery<unknown>('progress');
export const pauseAmazonBatch=defineSignal('pause');
export const resumeAmazonBatch=defineSignal('resume');
export const runAmazonBatchUntil=defineSignal<[number]>('runUntil');

/** Temporal owns the durable cursor, waits, pause/resume and bounded continuation.
 * Activities use the normal Brand intake; existing product workflows stay intact. */
export async function AmazonHistoryBatchWorkflow(raw:unknown):Promise<unknown>{
 const input=AmazonBatchInputSchema.parse(raw);
 if(workflowInfo().workflowId!==input.campaignId)throw ApplicationFailure.nonRetryable('Batch identity conflict','AMAZON.BATCH_IDENTITY');
 const call={campaignId:input.campaignId,manifestSha256:input.manifestSha256};
 // Control calls are idempotent (submission keyed by requestId; inspect/report read-only). A connectivity
 // blip must be retried for hours, not turned into a blocked campaign after six minutes.
 const longRetry=patched('batch-control-retry-v1');
 const a=proxyActivities<AmazonBatchActivities>(longRetry
  ?{taskQueue:input.controlQueue,startToCloseTimeout:'3 minutes',scheduleToCloseTimeout:'6 hours',heartbeatTimeout:'30 seconds',retry:{initialInterval:'5 seconds',maximumInterval:'5 minutes',backoffCoefficient:2}}
  :{taskQueue:input.controlQueue,startToCloseTimeout:'3 minutes',scheduleToCloseTimeout:'6 minutes',heartbeatTimeout:'30 seconds',retry:{maximumAttempts:3,initialInterval:'5 seconds',maximumInterval:'20 seconds'}});
 let paused=false,completedThisRun=0,stopAfter=input.stopAfter??null;
 const state={campaignId:input.campaignId,phase:'starting',cursor:input.cursor,totalChunks:0,totalProducts:0,stopAfter,requestId:null as string|null,workflowId:null as string|null,error:null as string|null,report:null as BatchReport|null,
  maxInFlight:input.maxInFlight,next:input.nextChunk??input.cursor,inFlight:[...(input.inFlight??[])] as number[]};
 setHandler(amazonBatchProgress,()=>state);
 setHandler(pauseAmazonBatch,()=>{paused=true;state.phase='paused';});
 setHandler(resumeAmazonBatch,()=>{stopAfter=null;state.stopAfter=null;paused=false;state.error=null;state.phase='running';});
 setHandler(runAmazonBatchUntil,target=>{
  if(!Number.isInteger(target)||target<state.cursor||target>2000||state.totalChunks>0&&target>state.totalChunks){paused=true;state.error='AMAZON.BATCH_STOP_CURSOR_INVALID';state.phase='blocked';return;}
  stopAfter=target;state.stopAfter=target;paused=state.cursor>=target;state.error=null;state.phase=paused?'paused':'running';
 });
 // Handlers are registered above so queries/signals work on both code paths.
 if(patched('batch-concurrent-chunks-v1'))return concurrentCampaign();
 for(;;){
  try{
   await condition(()=>!paused);
   const plan=await a.loadAmazonHistoryBatch(call);state.totalChunks=plan.requestIds.length;state.totalProducts=plan.totalProducts;
   if(state.cursor>plan.requestIds.length)throw ApplicationFailure.nonRetryable('Invalid cursor','AMAZON.BATCH_CURSOR');
   while(state.cursor<plan.requestIds.length){
    if(stopAfter!==null&&state.cursor>=stopAfter){paused=true;state.phase='paused';}
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
    if(stopAfter!==null&&state.cursor>=stopAfter){paused=true;state.phase='paused';}
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
  if(completedThisRun>=20){await condition(()=>!paused);return continueAsNew<typeof AmazonHistoryBatchWorkflow>({...input,cursor:state.cursor,stopAfter:stopAfter??undefined});}
 }
 /** Up to `maxInFlight` chunks run at once. `cursor` stays "chunks settled" (as before); `next` is the next
  * chunk to submit, so next - cursor == chunks in flight. Pause/stopAfter stop new submissions only; chunks
  * already submitted keep being inspected until they settle. */
 async function concurrentCampaign():Promise<unknown>{
  const inFlight=new Map<number,{requestId:string;workflowId:string|null}>();
  let next=input.nextChunk??input.cursor;
  const sync=()=>{state.inFlight=[...inFlight.keys()].sort((x,y)=>x-y);state.next=next;state.cursor=next-inFlight.size;};
  for(;;){
   try{
    await condition(()=>!paused);
    const plan=await a.loadAmazonHistoryBatch(call);state.totalChunks=plan.requestIds.length;state.totalProducts=plan.totalProducts;
    if(next>plan.requestIds.length||input.cursor>next)throw ApplicationFailure.nonRetryable('Invalid cursor','AMAZON.BATCH_CURSOR');
    for(const idx of input.inFlight??[])if(!inFlight.has(idx)){if(idx>=next||idx>=plan.requestIds.length)throw ApplicationFailure.nonRetryable('Invalid in-flight cursor','AMAZON.BATCH_CURSOR');inFlight.set(idx,{requestId:plan.requestIds[idx]!,workflowId:'v3-collection-'+plan.requestIds[idx]!});}
    sync();
    for(;;){
     let capacityWait=false;
     while(!paused&&inFlight.size<input.maxInFlight&&next<plan.requestIds.length&&(stopAfter===null||next<stopAfter)){
      const idx=next,requestId=plan.requestIds[idx]!;state.requestId=requestId;state.phase='running';
      const accepted=await a.submitAmazonHistoryChunk({...call,requestId});
      if(!accepted.accepted){capacityWait=true;break;}
      inFlight.set(idx,{requestId,workflowId:accepted.workflowId});state.workflowId=accepted.workflowId;next++;sync();
     }
     if(stopAfter!==null&&state.cursor>=stopAfter&&!inFlight.size)paused=true;
     if(!inFlight.size){
      if(next>=plan.requestIds.length)break;
      if(paused){state.phase='paused';await condition(()=>!paused);continue;}
      if(capacityWait){state.phase='waiting-for-capacity';await sleep('30 seconds');}
      continue;
     }
     state.phase=paused?'paused':'waiting-for-products';
     for(const [idx,chunk] of [...inFlight]){
      const result=await a.inspectAmazonHistoryChunk({...call,requestId:chunk.requestId});
      if(result.settled){inFlight.delete(idx);completedThisRun++;sync();}
      else await a.recoverAmazonHistoryChunk({...call,requestId:chunk.requestId});
     }
     state.report=await a.reportAmazonHistoryBatch(call);
     if(stopAfter!==null&&state.cursor>=stopAfter&&!inFlight.size){paused=true;state.phase='paused';}
     if(completedThisRun>=20&&!inFlight.size&&next<plan.requestIds.length)break;
     if(inFlight.size)await sleep('30 seconds');
    }
    if(next===plan.requestIds.length&&!inFlight.size){state.phase='complete';state.requestId=null;state.workflowId=null;state.report=await a.reportAmazonHistoryBatch(call);return state;}
   }catch(error){
    if(isCancellation(error))throw error;
    // A failed RPC is never permission to skip a chunk or invent a new request; in-flight chunks are kept and re-inspected after resume.
    state.error=error instanceof Error?error.message.slice(0,500):'AMAZON.BATCH_CONTROL_UNVERIFIED';state.phase='blocked';paused=true;
    await condition(()=>!paused);
   }
   if(completedThisRun>=20&&!inFlight.size){await condition(()=>!paused);return continueAsNew<typeof AmazonHistoryBatchWorkflow>({...input,cursor:state.cursor,nextChunk:next,stopAfter:stopAfter??undefined,inFlight:[]});}
  }
 }
}
