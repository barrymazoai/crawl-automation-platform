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
  await h.signal('resume');expect(await h.result()).toMatchObject({phase:'complete',cursor:22,totalProducts:2000});
  expect(new Set(submissions)).toEqual(new Set(requestIds));expect(submissions.filter(id=>id!==requestIds[0])).toHaveLength(21);
  const firstHandle=env.client.workflow.getHandle(campaignId,h.firstExecutionRunId),firstHistory=await firstHandle.fetchHistory();
  expect(firstHistory.events?.some(e=>e.workflowExecutionContinuedAsNewEventAttributes)).toBe(true);
  await Worker.runReplayHistory({workflowBundle},firstHistory,campaignId);
  const finalHandle=env.client.workflow.getHandle(campaignId);await Worker.runReplayHistory({workflowBundle},await finalHandle.fetchHistory(),campaignId);
 }finally{for(const w of workers)if(w.getState()==='RUNNING')w.shutdown();await Promise.allSettled(runs);await env.teardown();}
},120000);
