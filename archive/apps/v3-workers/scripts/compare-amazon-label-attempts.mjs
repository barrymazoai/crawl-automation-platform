// Read-only comparison of model input hashes and outcomes in existing histories.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {Client,Connection} from '@temporalio/client';
import {defaultPayloadConverter} from '@temporalio/common';
import temporalProto from '@temporalio/proto';
const [work]=process.argv.slice(2),previous='/Users/barry/apps/crawlv3-history-20260913/amazon-throughput-20260914';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),decode=v=>v?.payloads?.length?defaultPayloadConverter.fromPayload(v.payloads[0]):null;
const r=await read(work+'/control.runtime.json'),t=r.transport,inspection=await read(work+'/inspection.json'),{out}=await read(previous+'/acceptance-10.json'),timing=await read(out+'/timing.json');
const connection=await Connection.connect({address:r.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
function describe(history){
 const events=temporalProto.temporal.api.history.v1.History.fromObject(history).events,input=decode(events[0].workflowExecutionStartedEventAttributes.input),asin=input?.input?.sourcePlan?.owner?.listingId;
 const attempts=events.filter(e=>e.activityTaskScheduledEventAttributes?.activityType?.name==='interpretImage').map(e=>{
  const task=decode(e.activityTaskScheduledEventAttributes.input),completed=events.find(x=>x.activityTaskCompletedEventAttributes?.scheduledEventId?.toString()===e.eventId.toString()),result=decode(completed?.activityTaskCompletedEventAttributes.result);
  return{imageSha256:task.input.selection.image.sha256,configFingerprint:task.configFingerprint,status:result?.status??'pending',reviewId:result?.reviewId??null};
 });return{asin,attempts};
}
try{
 const old=new Map();for(const w of timing.workflows.filter(w=>w.type==='ChannelStreamingLabelWorkflow')){const d=describe(await read(out+'/history-'+w.runId+'.json'));old.set(d.asin,d);}
 const client=new Client({connection,namespace:r.namespace}),rows=[];
 for(const asin of ['B01IAI2MB8','B0H2BRKTMX']){
  const p=inspection.products.find(p=>p.asin===asin);assert.ok(p?.child);
  const current=describe(await client.workflow.getHandle(p.workflowId+'-label').fetchHistory()),prior=old.get(asin);assert.ok(prior);
  rows.push({asin,previous:prior.attempts,current:current.attempts,firstImageUnchanged:prior.attempts[0]?.imageSha256===current.attempts[0]?.imageSha256,modelConfigUnchanged:prior.attempts[0]?.configFingerprint===current.attempts[0]?.configFingerprint});
 }
 const result={at:new Date().toISOString(),rows};await fs.writeFile(work+'/label-attempt-comparison.json',JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));
}finally{await connection.close();}
