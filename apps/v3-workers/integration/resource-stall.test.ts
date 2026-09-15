import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';
import {Context} from '@temporalio/activity';
import {TestWorkflowEnvironment} from '@temporalio/testing';
import {Worker} from '@temporalio/worker';
import {RetainedPublication} from '@crawl-automation/v3-artifacts';
import {fixture} from '../../../packages/v3-text/src/testing.fixture.js';
import {MemoryObjects} from '../../../packages/v3-results/src/testing.fixture.js';
import {QualityReviewStops} from '../src/quality-review-stops.js';

it('Mini Temporal: lost stop-proof PUT recovers; persistent failure ends sibling waits without another model invocation',async()=>{
 if(!/^barrydeMac-mini(?:\.|$)/.test(hostname()))throw Error('Run integration on Mac mini');
 const env=await TestWorkflowEnvironment.createLocal({server:{ip:'127.0.0.1',ui:false,executable:{type:'cached-download',version:'v1.8.3'}}});
 const workflowBundle={codePath:join(dirname(fileURLToPath(import.meta.url)),'resource-stall-workflows.cjs')};
 try{for(const permanent of [false,true]){
  const f=fixture(),resourcesLocal=new MemoryObjects(),review:any={reviewId:'review-'+randomUUID(),observation:f.owner,failure:{operationId:f.input.operationId,inputFingerprint:f.input.inputFingerprint,code:'TEXT.LABEL_GROUP_EMPTY',executionFact:'executed'}};
  const outcome={status:'review',reviewId:review.reviewId,operationId:f.input.operationId,code:review.failure.code};
  const reader={read:async()=>review},modelStops=new QualityReviewStops(new RetainedPublication(f.local,f.remote),reader,true),verifier=new QualityReviewStops(new RetainedPublication(resourcesLocal,f.remote),reader,true);
  let text=0,image=0,failures=0;const create=f.remote.create.bind(f.remote),held=new Map<string,unknown>();
  f.remote.create=async(k,b)=>{if(k.startsWith('v3/resource-stop/')&&(permanent||failures++===0))throw Error('Injected stop proof transport failure');return create(k,b);};
  const queue='stall-'+randomUUID(),w=await Worker.create({connection:env.nativeConnection,taskQueue:queue,workflowBundle,activities:{
   reserveResources:async(r:any)=>{if(held.size&&!held.has(r.permitId))return{permitId:r.permitId,status:'waiting',reason:'capacity'};held.set(r.permitId,r);return{permitId:r.permitId,status:'granted',reason:'available'};},
   releaseResources:async(r:any)=>{expect(held.get(r.permitId)).toEqual(r);held.delete(r.permitId);return{permitId:r.permitId,status:'released',reason:'released'};},
   interpretText:async()=>{const c=Context.current(),execution=c.info.workflowExecution;if(!execution)throw Error('Missing workflow execution');return modelStops.run({...execution,activityId:c.info.activityId},'interpretText',f.input,async()=>{text++;modelStops.returned('response');return outcome;});},
   interpretImage:async()=>{image++;return{status:'registered'};},
   verifyResourceReviewStopped:async(r:any)=>verifier.verify(r,Context.current().cancellationSignal),
  }}),running=w.run();running.catch(()=>{});
  try{
   const h=await env.client.workflow.start('ResourceStallFixture',{workflowId:queue,taskQueue:queue,args:[queue],workflowExecutionTimeout:'45 seconds'}),result=await h.result();
   expect({permanent,text,image,held:held.size,result}).toMatchObject({permanent,text:1,image:permanent?0:1,held:permanent?1:0});expect(review.failure.code).toBe('TEXT.LABEL_GROUP_EMPTY');
   expect(result.map((r:any)=>r.status)).toEqual(permanent?['rejected','rejected']:['fulfilled','fulfilled']);
   if(permanent)expect(result.map((r:any)=>r.code)).toEqual(['RESOURCE.REVIEW_STOP_UNVERIFIED','RESOURCE.OWNER_QUARANTINED']);
   const history=await h.fetchHistory();expect(history.events!.length).toBeLessThan(150);await Worker.runReplayHistory({workflowBundle},history,queue);
  }finally{w.shutdown();await running;}
 }}finally{await env.teardown();}
},120000);

it('Mini Temporal: errors and cancellation verify stopped work, release once and preserve the original failure',async()=>{
 if(!/^barrydeMac-mini(?:\.|$)/.test(hostname()))throw Error('Run integration on Mac mini');
 const env=await TestWorkflowEnvironment.createLocal({server:{ip:'127.0.0.1',ui:false,executable:{type:'cached-download',version:'v1.8.3'}}});
 const workflowBundle={codePath:join(dirname(fileURLToPath(import.meta.url)),'resource-stall-workflows.cjs')};
 try{for(const mode of ['error','cancel','unknown']){
  const f=fixture(),reader={read:async()=>null},model=new QualityReviewStops(new RetainedPublication(f.local,f.remote),reader,true),verifier=new QualityReviewStops(new RetainedPublication(new MemoryObjects(),f.remote),reader,true);
  let held=false,releases=0,closed=false,started!:()=>void;const startedPromise=new Promise<void>(resolve=>{started=resolve;});
  const queue='finally-'+randomUUID(),w=await Worker.create({connection:env.nativeConnection,taskQueue:queue,workflowBundle,activities:{
   reserveResources:async(r:any)=>{held=true;return{permitId:r.permitId,status:'granted',reason:'available'};},
   releaseResources:async(r:any)=>{expect(closed).toBe(true);held=false;releases++;return{permitId:r.permitId,status:'released',reason:'released'};},
   interpretText:async()=>{const c=Context.current();return model.run({...c.info.workflowExecution!,activityId:c.info.activityId},'interpretText',f.input,async()=>{
    const timer=setInterval(()=>c.heartbeat(),100);started();
    try{if(mode==='cancel')await c.cancelled;throw Error('synthetic original failure');}
    finally{clearInterval(timer);if(mode!=='unknown'){closed=true;model.closed();}}
   });},
   verifyResourceReviewStopped:async(r:any)=>verifier.verify(r,Context.current().cancellationSignal),
  }}),running=w.run();running.catch(()=>{});
  try{
   const h=await env.client.workflow.start('ResourceFinallyFixture',{workflowId:queue,taskQueue:queue,args:[queue],workflowExecutionTimeout:'30 seconds'});
   await startedPromise;if(mode==='cancel')await h.cancel();await expect(h.result()).rejects.toThrow();
   expect(held).toBe(mode==='unknown');expect(releases).toBe(mode==='unknown'?0:1);
   const state=await h.describe();expect(state.status.name).toBe(mode==='cancel'?'CANCELLED':'FAILED');
   await Worker.runReplayHistory({workflowBundle},await h.fetchHistory(),queue);
  }finally{w.shutdown();await running;}
 }}finally{await env.teardown();}
},120000);
