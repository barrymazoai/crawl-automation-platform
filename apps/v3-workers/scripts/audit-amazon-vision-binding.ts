import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {hostname} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pg from 'pg';
import {Client,Connection} from '@temporalio/client';
import {defaultPayloadConverter} from '@temporalio/common';
import {VisionTaskSchema} from '@crawl-automation/v3-contracts';
import {CodexVisionProvider,visionFingerprint} from '@crawl-automation/v3-vision';
import {createR2Objects,sha256} from '@crawl-automation/v3-artifacts';
import {TextLocalStore} from '@crawl-automation/v3-text';
import {artifactBuildId} from '@crawl-automation/v3-worker-runtime';
import {PostgresResourceAdmission} from '../../../packages/v3-product/src/resource-admission.js';
import {dirname,join} from 'node:path';
const mode=process.argv[2]??'--audit';assert.ok(['--audit','--release'].includes(mode));assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const read=async(p:string)=>JSON.parse(await fs.readFile(p,'utf8')),root='/Users/barry/apps/crawlv3-batch-a.UiA4dx';
const m=await read(root+'/live/deployment.json'),j=m.jobs.find((j:any)=>j.id==='amazon-channel-label-vision'),c=await read(j.env.V3_CHANNEL_LABEL_CONFIG),r=await read(j.env.V3_WORKER_CONFIG),t=r.transport;
const connection=await Connection.connect({address:r.address,tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
try{
 const workflowId='catalog-product-9816d24c5a5335434b034c69a9edc0cef1ee8eefa23cd673bc38a90df0812f08-label',runId='01a09b32-184c-74ed-a5da-6101a5394a66',permitId=`permit-${runId}-6`;
 const client=new Client({connection,namespace:r.namespace}),handle=client.workflow.getHandle(workflowId,runId),state=await handle.describe(),history=await handle.fetchHistory(),meta=CodexVisionProvider.describe(c.codex);
 assert.equal(state.status.name,'COMPLETED');assert.equal(state.runId,runId);assert.equal(state.raw.pendingActivities?.length??0,0);
 const calls=(history.events??[]).filter(e=>e.activityTaskScheduledEventAttributes?.activityType?.name==='interpretImage');assert.equal(calls.length,1);
 for(const e of history.events??[])if(e.activityTaskScheduledEventAttributes?.activityType?.name==='interpretImage'){
  const task=VisionTaskSchema.parse(defaultPayloadConverter.fromPayload(e.activityTaskScheduledEventAttributes!.input!.payloads![0]!));
  console.log(JSON.stringify({operationId:task.input.operationId,taskFingerprint:task.configFingerprint,providerFingerprint:meta.configFingerprint,match:task.configFingerprint===meta.configFingerprint,extractionProtocol:task.input.extractionProtocol,providerProtocol:meta.extractionProtocol,visionFingerprint:visionFingerprint(task)}));
  assert.notEqual(task.configFingerprint,meta.configFingerprint);assert.equal(task.input.selection.observation.listingId,'B00IG0MJKA');
  const events=history.events??[],started=events.filter(x=>x.activityTaskStartedEventAttributes?.scheduledEventId?.toString()===e.eventId?.toString()),failed=events.filter(x=>x.activityTaskFailedEventAttributes?.scheduledEventId?.toString()===e.eventId?.toString());
  assert.equal(started.length,1);assert.equal(started[0]!.activityTaskStartedEventAttributes!.attempt??1,1);assert.equal(failed.length,1);
  assert.equal(failed[0]!.activityTaskFailedEventAttributes!.failure!.applicationFailureInfo!.type,'CHANNEL.ACTIVITY_UNRESOLVED');
  const failedAt=Number(failed[0]!.eventTime!.seconds)*1000+Number(failed[0]!.eventTime!.nanos??0)/1e6;
  assert.ok((await fs.stat(j.env.V3_CHANNEL_LABEL_CONFIG)).mtimeMs<failedAt);
  const artifactRoot=dirname(j.entry),actualBuild=await artifactBuildId((await fs.readdir(artifactRoot)).filter(n=>n.endsWith('.js')).sort().map(n=>join(artifactRoot,n)));assert.equal(actualBuild,r.expectedBuildId);
  const deployed=await fs.readFile(j.entry,'utf8');assert.match(deployed,/task\.configFingerprint\s*!==\s*meta\.configFingerprint\)\s*throw Error\("VISION.CONFIG_MISMATCH"\)/);
  const db=new pg.Pool({connectionString:c.database.connectionString,max:1}),remote=createR2Objects(c.r2,c.r2Credentials),local=await TextLocalStore.open(c.root+'/vision/journal');
  try{
   assert.equal(new URL(c.database.connectionString).pathname,'/crawler_v3_test');const ledger=new PostgresResourceAdmission(db),held=await ledger.read(permitId);assert.ok(held);assert.equal(held.released,false);assert.equal(held.request.workflowId,workflowId);assert.equal(held.request.runId,runId);
   assert.deepEqual(held.request.needs.map(n=>n.resourceId).sort(),['mini-cpu','mini-model-account']);
   const grants=events.filter(x=>x.activityTaskScheduledEventAttributes?.activityType?.name==='reserveResources'&&(defaultPayloadConverter.fromPayload(x.activityTaskScheduledEventAttributes!.input!.payloads![0]!) as any).permitId===permitId);
   const grantedCalls=grants.filter(g=>events.some(x=>x.activityTaskCompletedEventAttributes?.scheduledEventId?.toString()===g.eventId?.toString()&&(defaultPayloadConverter.fromPayload(x.activityTaskCompletedEventAttributes!.result!.payloads![0]!) as any).status==='granted'));assert.equal(grantedCalls.length,1);const grant=grantedCalls[0]!;
   assert.deepEqual(defaultPayloadConverter.fromPayload(grant.activityTaskScheduledEventAttributes!.input!.payloads![0]!),held.request);
   const granted=events.find(x=>x.activityTaskCompletedEventAttributes?.scheduledEventId?.toString()===grant.eventId?.toString());assert.ok(granted);assert.equal((defaultPayloadConverter.fromPayload(granted.activityTaskCompletedEventAttributes!.result!.payloads![0]!) as any).status,'granted');assert.ok(Number(e.eventId)>Number(granted.eventId));
   for(const suffix of ['intent.json','response.json','failure.json']){const key=`v3/vision/${task.input.operationId}/${suffix}`;assert.equal(await remote.store.read(key,2097152,AbortSignal.timeout(15000)),null);assert.equal(await local.read(key,2097152,AbortSignal.timeout(10000)),null);}
   const noProcesses=async()=>{const cwd=(await promisify(execFile)('/usr/sbin/lsof',['-a','-u','barry','-d','cwd','-Fn'],{maxBuffer:8388608})).stdout;assert.ok(!cwd.split('\n').some(l=>l===`n${c.codex.workRoot}`||l.startsWith(`n${c.codex.workRoot}/`)));return{at:new Date().toISOString(),modelCwdAbsent:true};};
   const proof={codec:'amazon-vision-config-recovery/1',request:held.request,operationId:task.input.operationId,taskFingerprint:task.configFingerprint,actualProviderFingerprint:meta.configFingerprint,actualBuild,guard:'VISION.CONFIG_MISMATCH before handoff/provider access',historySha256:sha256(Buffer.from(JSON.stringify(history))),remoteAndLocalIntentResponseFailureAbsent:true,processProof:await noProcesses(),oldReviewPreserved:true};
   const out='/Users/barry/apps/crawlv3-history-20260913/amazon-5-us-20260913/vision-config-recovery';await fs.mkdir(out,{recursive:true,mode:0o700});await fs.writeFile(out+'/audit.json',JSON.stringify(proof,null,2),{mode:0o600});
   const key=`v3/amazon-history-recovery/${permitId}/config-proof.json`;
   if(mode==='--release'){
    const keep=async(k:string,b:Buffer)=>{await remote.store.create(k,b,'application/json',AbortSignal.timeout(30000));assert.deepEqual(Buffer.from((await remote.store.read(k,b.length,AbortSignal.timeout(30000)))!),b);};
    await keep(key.replace('config-proof.json','history.json'),Buffer.from(JSON.stringify(history)));await keep(key,Buffer.from(JSON.stringify(proof)));await noProcesses();assert.equal((await client.workflow.getHandle(workflowId).describe()).runId,runId);
    await ledger.release(held.request);assert.equal((await ledger.read(permitId))?.released,true);await fs.writeFile(out+'/released.json',JSON.stringify({proofKey:key,at:new Date().toISOString()}),{mode:0o600,flag:'wx'});
   }
   console.log(JSON.stringify({status:mode==='--release'?'released':'recoverable',permitId,proofKey:mode==='--release'?key:null}));
  }finally{await db.end();remote.close();}
 }
 const a=await read(m.jobs.find((j:any)=>j.id==='amazon-capture').env.V3_AMAZON_LIVE_CONFIG);console.log(JSON.stringify({configuredLabelVision:a.visionConfigFingerprint,configuredSourceVision:a.sourceVisionConfigFingerprint}));
}finally{await connection.close();}
