import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect,it,vi} from 'vitest';
import {TestWorkflowEnvironment} from '@temporalio/testing';
import {Worker} from '@temporalio/worker';
import {ApplicationFailure} from '@temporalio/common';

it('Mini: batch cursor survives Worker restart, pause/resume and ContinueAsNew; unverifiable recovery blocks advancement',async()=>{
 if(!/^barrydeMac-mini(?:\.|$)/.test(hostname()))throw Error('Run integration on Mac mini');
 const env=await TestWorkflowEnvironment.createLocal({server:{ip:'127.0.0.1',ui:false,executable:{type:'cached-download',version:'v1.8.3'}}});
 const workflowBundle={codePath:join(dirname(fileURLToPath(import.meta.url)),'amazon-batch-workflows.cjs')};
 const campaignId='batch-'+randomUUID(),queue=campaignId,requestIds=Array.from({length:22},()=>randomUUID());
 const submissions:string[]=[],report={at:new Date().toISOString(),requested:2000,submittedProducts:0,submittedAttempts:0,captures:0,capturedProducts:0,savedProducts:0,moduleReviewRecords:0,pricePoints:0,comparablePricePoints:0,priceChangeExamples:[]};
 let firstSettled=false,recoveryUnknown=true,recoveries=0;
 const activities={loadAmazonHistoryBatch:async()=>({requestIds,totalProducts:2000}),submitAmazonHistoryChunk:async({requestId}:any)=>{submissions.push(requestId);return{accepted:true,workflowId:'product-'+requestId};},
  inspectAmazonHistoryChunk:async({requestId}:any)=>({settled:requestId!==requestIds[0]||firstSettled,workflowId:'product-'+requestId,state:'RUNNING'}),
  recoverAmazonHistoryChunk:async()=>{recoveries++;if(recoveryUnknown)throw ApplicationFailure.nonRetryable('Unknown page ownership','TEST.RECOVERY_UNVERIFIED');return{status:'not-needed'};},reportAmazonHistoryBatch:async()=>report};
 const workers:Worker[]=[],runs:Promise<void>[]=[];
 const start=async()=>{const w=await Worker.create({connection:env.nativeConnection,taskQueue:queue,workflowBundle,activities});workers.push(w);const run=w.run();run.catch(()=>{});runs.push(run);return w;};
 try{
  const first=await start(),h=await env.client.workflow.start('AmazonHistoryBatchWorkflow',{workflowId:campaignId,taskQueue:queue,args:[{campaignId,manifestSha256:'a'.repeat(64),controlQueue:queue}]});
  await vi.waitFor(async()=>expect(await h.query('progress')).toMatchObject({phase:'blocked',cursor:0}),{timeout:15000});
  expect(submissions).toEqual([requestIds[0]]);expect(recoveries).toBe(1);
  first.shutdown();await runs[0];await start();
  expect(await h.query('progress')).toMatchObject({phase:'blocked',cursor:0});
  recoveryUnknown=false;await h.signal('resume');
  await vi.waitFor(()=>expect(recoveries).toBe(2),{timeout:10000});
  await h.signal('pause');firstSettled=true;
  await vi.waitFor(async()=>expect(await h.query('progress')).toMatchObject({phase:'paused',cursor:1}),{timeout:45000});
  expect(new Set(submissions)).toEqual(new Set([requestIds[0]]));
  await h.signal('runUntil',21);
  await vi.waitFor(async()=>expect(await h.query('progress')).toMatchObject({phase:'paused',cursor:21,stopAfter:21}),{timeout:20000});
  expect(new Set(submissions)).toEqual(new Set(requestIds.slice(0,21)));
  // The limit crosses ContinueAsNew and survives another cold Worker restart.
  workers.at(-1)!.shutdown();await runs.at(-1);await start();
  expect(await h.query('progress')).toMatchObject({phase:'paused',cursor:21,stopAfter:21});
  await h.signal('resume');expect(await h.result()).toMatchObject({phase:'complete',cursor:22,totalProducts:2000,stopAfter:null});
  expect(new Set(submissions)).toEqual(new Set(requestIds));expect(submissions.filter(id=>id!==requestIds[0])).toHaveLength(21);
  const firstHandle=env.client.workflow.getHandle(campaignId,h.firstExecutionRunId),firstHistory=await firstHandle.fetchHistory();
  expect(firstHistory.events?.some(e=>e.workflowExecutionContinuedAsNewEventAttributes)).toBe(true);
  await Worker.runReplayHistory({workflowBundle},firstHistory,campaignId);
  const finalHandle=env.client.workflow.getHandle(campaignId);await Worker.runReplayHistory({workflowBundle},await finalHandle.fetchHistory(),campaignId);
 }finally{for(const w of workers)if(w.getState()==='RUNNING')w.shutdown();await Promise.allSettled(runs);await env.teardown();}
},120000);

it('Mini: concurrent chunks keep at most maxInFlight requests open, pause stops new submissions only, and ContinueAsNew carries in-flight cursors',async()=>{
 if(!/^barrydeMac-mini(?:\.|$)/.test(hostname()))throw Error('Run integration on Mac mini');
 const env=await TestWorkflowEnvironment.createLocal({server:{ip:'127.0.0.1',ui:false,executable:{type:'cached-download',version:'v1.8.3'}}});
 const workflowBundle={codePath:join(dirname(fileURLToPath(import.meta.url)),'amazon-batch-workflows.cjs')};
 const campaignId='batch-c-'+randomUUID(),queue=campaignId,requestIds=Array.from({length:25},()=>randomUUID());
 const report={at:new Date().toISOString(),requested:250,submittedProducts:0,submittedAttempts:0,captures:0,capturedProducts:0,savedProducts:0,moduleReviewRecords:0,pricePoints:0,comparablePricePoints:0,priceChangeExamples:[]};
 const open=new Set<string>(),settled=new Set<string>(),submissions:string[]=[];let peak=0,release=false;
 const activities={loadAmazonHistoryBatch:async()=>({requestIds,totalProducts:250}),
  submitAmazonHistoryChunk:async({requestId}:any)=>{submissions.push(requestId);open.add(requestId);peak=Math.max(peak,open.size);return{accepted:true,workflowId:'product-'+requestId};},
  inspectAmazonHistoryChunk:async({requestId}:any)=>{const done=release||settled.has(requestId);if(done){open.delete(requestId);settled.add(requestId);}return{settled:done,workflowId:'product-'+requestId,state:done?'COMPLETED':'RUNNING'};},
  recoverAmazonHistoryChunk:async()=>({status:'not-needed'}),reportAmazonHistoryBatch:async()=>report};
 const workers:Worker[]=[],runs:Promise<void>[]=[];
 const start=async()=>{const w=await Worker.create({connection:env.nativeConnection,taskQueue:queue,workflowBundle,activities});workers.push(w);const run=w.run();run.catch(()=>{});runs.push(run);return w;};
 try{
  await start();const h=await env.client.workflow.start('AmazonHistoryBatchWorkflow',{workflowId:campaignId,taskQueue:queue,args:[{campaignId,manifestSha256:'a'.repeat(64),controlQueue:queue,maxInFlight:3}]});
  await vi.waitFor(async()=>expect(await h.query('progress')).toMatchObject({phase:'waiting-for-products',cursor:0,next:3,inFlight:[0,1,2]}),{timeout:15000});
  expect(new Set(submissions).size).toBe(3);expect(peak).toBe(3);
  // Pausing stops new submissions; already open chunks still settle.
  await h.signal('pause');settled.add(requestIds[1]!);
  await vi.waitFor(async()=>expect(await h.query('progress')).toMatchObject({phase:'paused',cursor:1,next:3,inFlight:[0,2]}),{timeout:45000});
  expect(new Set(submissions).size).toBe(3);
  // A cold restart while chunks are open must not resubmit or lose them.
  workers.at(-1)!.shutdown();await runs.at(-1);await start();
  await h.signal('resume');release=true;
  expect(await h.result()).toMatchObject({phase:'complete',cursor:25,next:25,inFlight:[],totalProducts:250});
  expect(new Set(submissions).size).toBe(25);expect(submissions.length).toBe(25);expect(peak).toBeLessThanOrEqual(3);
 }finally{for(const w of workers){try{w.shutdown();}catch{/* already stopped by the restart step */}}await Promise.allSettled(runs);await env.teardown();}
},180000);
