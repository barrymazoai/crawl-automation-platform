import { startChild, ParentClosePolicy, WorkflowIdReusePolicy, ApplicationFailure, CancellationScope, isCancellation, type ChildWorkflowHandle } from '@temporalio/workflow';
import { AmazonProductCaptureSchema, AmazonStagedFilesSchema, AmazonProductHandoffSchema, ChannelPlanOutcomeSchema, FileAcquireOutcomeSchema, AcquisitionReviewSchema, type AmazonProductJob } from '@crawl-automation/v3-contracts';
import { resourceGate } from './resource-workflow.js';
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const invalid=()=>{throw ApplicationFailure.nonRetryable('Amazon staged file identity conflict','AMAZON.STAGE_IDENTITY_CONFLICT');};
function code(error:unknown){let current=error;for(let n=0;n<8&&current&&typeof current==='object';n++){const e=current as {type?:unknown;cause?:unknown};if(typeof e.type==='string'&&/^(AMAZON|SOURCE|ACQUIRE|ARTIFACT|RESOURCE)\.[A-Z_]+$/.test(e.type))return e.type;current=e.cause;}return 'AMAZON.FILE_PUBLICATION_UNRESOLVED';}

/** All origin bytes and local checks finish before page close/lease release.
 * Cloud-only file Activities can then overlap the next product's browser phase. */
export async function detachedAmazonProduct(job:AmazonProductJob,inputQueue:string,call:(queue:string,name:string,value:unknown)=>Promise<unknown>){
 let captured:ReturnType<typeof AmazonProductCaptureSchema.parse>|undefined,staged:ReturnType<typeof AmazonStagedFilesSchema.parse>|undefined;
 const review=async(error:unknown,stage:'AMAZON.BROWSER_PHASE_UNRESOLVED'|'AMAZON.FILE_PUBLICATION_UNRESOLVED')=>{
  const r=AcquisitionReviewSchema.parse(await call(job.queues.review,'reviewAmazonProduct',{job,code:stage,causeCode:code(error)}));if(r.operationId!==job.operationId)invalid();return r;
 };
 try{
  const phase=await resourceGate(job.resources)('browserSession',async()=>{
   let cleanupAllowed=true;
   try{
    const raw=await call(job.queues.capture,'captureAmazonProduct',job),r=AcquisitionReviewSchema.safeParse(raw);
    if(r.success){if(r.data.operationId!==job.operationId)invalid();if(r.data.code==='SOURCE.BROWSER_USER_CONTROL')cleanupAllowed=false;return r.data;}
    captured=AmazonProductCaptureSchema.parse(raw);const p=captured.sourcePlan,o=p.owner,d=job.discovery;
    if(!same(captured.job,job)||o.requestId!==d.catalogId||o.brandId!==d.scope.brandId||o.sourceId!==d.scope.sourceId||o.listingId!==d.entry.listingId||o.variantId!==d.entry.variantId||p.expectedUrl!==d.entry.url||p.binding.sessionId!==job.sessionId||p.source.producer.operationId!==job.operationId)invalid();
    const plan=ChannelPlanOutcomeSchema.parse(await call(job.queues.plan,'prepareChannelProduct',p));
    if(plan.operationId!==p.operationId)invalid();if(plan.status==='review')return plan;if(!same(plan.manifest.observation,o))invalid();
    staged=AmazonStagedFilesSchema.parse(await call(job.queues.capture,'stageAmazonProductFiles',captured));
    const files=plan.manifest.sources.filter(s=>s.kind==='file-image');
    if(!same(staged.capture,captured)||staged.files.length!==files.length)invalid();
    for(const [i,source]of files.entries()){const f=staged.files[i]!;if(f.sourceId!==source.id||!same(f.record.input,source.plan.acquire)||f.record.file.artifactId!==source.plan.imageId)invalid();}
    return null;
   }catch(error){if(code(error)==='SOURCE.BROWSER_USER_CONTROL')cleanupAllowed=false;throw error;}
   finally{if(cleanupAllowed)await CancellationScope.nonCancellable(async()=>{
    const r=await call(job.queues.capture,'closeAmazonProductPage',job) as {taskId?:string;status?:string};
    if(r?.taskId!==job.sessionId||!['closed','not-opened'].includes(r?.status??''))throw ApplicationFailure.nonRetryable('Page closure unverified','SOURCE.PAGE_CLOSE_UNKNOWN');
   });}
  });
  if(phase)return phase;
 }catch(error){if(isCancellation(error))throw error;return review(error,'AMAZON.BROWSER_PHASE_UNRESOLVED');}
 if(!captured||!staged)invalid();
 let child:ChildWorkflowHandle<(raw:unknown)=>Promise<unknown>>|undefined,labelId:string|undefined;
 const seal=(status:'closed'|'failed')=>child!.signal('channelStreamSealed',{operationId:labelId,status});
 try{
  const prepared=AmazonProductHandoffSchema.parse(await call(inputQueue,'prepareAmazonStreamingLabel',captured));
  if(!same(prepared.job,job)||!same(prepared.input.input.sourcePlan,captured!.sourcePlan))invalid();labelId=prepared.input.input.operationId;
  child=await startChild('ChannelStreamingLabelWorkflow',{workflowId:`${job.discovery.workflowId}-label`,taskQueue:job.queues.label,args:[prepared.input],parentClosePolicy:ParentClosePolicy.REQUEST_CANCEL,workflowIdReusePolicy:WorkflowIdReusePolicy.REJECT_DUPLICATE,retry:{maximumAttempts:1}});
  const retained=staged!;
  for(let offset=0;offset<retained.files.length;offset+=2){
   const group=retained.files.slice(offset,offset+2);
   const results=await Promise.allSettled(group.map(f=>call(job.queues.file,'publishAmazonStagedFile',{staged:retained,sourceId:f.sourceId})));
   let failed:unknown,passive:Extract<ReturnType<typeof FileAcquireOutcomeSchema.parse>,{status:'review'}>|undefined;
   for(const [i,result]of results.entries()){
    if(result.status==='rejected'){failed??=result.reason;continue;}
    const receipt=FileAcquireOutcomeSchema.parse(result.value),f=group[i]!;
    if(receipt.operationId!==f.record.input.operationId)invalid();
    if(receipt.status==='review'){passive??=receipt;continue;}
    if(!same(receipt.file,f.record.file))invalid();
    await child.signal('channelSourceReady',{operationId:labelId,sourceId:f.sourceId,file:receipt.file});
   }
   if(failed)throw failed;
   if(passive){await seal('failed');await child.result();return passive;}
  }
  await seal('closed');return child.result();
 }catch(error){
  if(child)await CancellationScope.nonCancellable(async()=>{try{await seal('failed');}catch{/* REQUEST_CANCEL also closes the child if signalling is unavailable. */}});
  if(isCancellation(error))throw error;
  const outcome=await review(error,'AMAZON.FILE_PUBLICATION_UNRESOLVED');if(child)await child.result();return outcome;
 }
}
