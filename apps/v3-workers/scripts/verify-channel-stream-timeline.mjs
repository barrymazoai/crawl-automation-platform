/** Read-only retained-history verification. No Activities, providers, submissions or retries. */
import fs from'node:fs/promises';import assert from'node:assert/strict';import{hostname}from'node:os';import{createRequire}from'node:module';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const root='/Users/barry/apps/crawlv3-batch-a.UiA4dx',requestId=process.argv[2];assert.match(requestId??'',/^[a-f0-9-]{36}$/);
const dir=root+'/live/channel-resident-20260910-v2/evidence/request-'+requestId,report=JSON.parse(await fs.readFile(dir+'/report.json'));
assert.ok(report.workflows.every(w=>w.status==='COMPLETED'));assert.equal(report.held,0);
const read=async w=>JSON.parse(await fs.readFile(dir+'/history-'+w.runId+'.json'));
const time=e=>Number(e.eventTime.seconds)*1000+Number(e.eventTime.nanos??0)/1e6;
const decode=p=>p?.payloads?.[0]?.data?JSON.parse(Buffer.from(p.payloads[0].data,'base64').toString()):undefined;
function activityRows(h){
 const rows=new Map();for(const e of h.events){const a=e.activityTaskScheduledEventAttributes;if(a)rows.set(e.eventId,{id:e.eventId,name:a.activityType.name,input:decode(a.input),maxAttempts:a.retryPolicy?.maximumAttempts,scheduled:time(e)});
  const s=e.activityTaskStartedEventAttributes;if(s)Object.assign(rows.get(s.scheduledEventId),{started:time(e),attempt:s.attempt});
  const c=e.activityTaskCompletedEventAttributes;if(c)Object.assign(rows.get(c.scheduledEventId),{completed:time(e),result:decode(c.result)});
 }return[...rows.values()];
}
const products=[];
for(const w of report.workflows.filter(w=>w.type==='SwansonCatalogProductWorkflow')){
 const child=report.workflows.find(c=>c.workflowId===w.workflowId+'-label');assert.equal(child?.type,'ChannelStreamingLabelWorkflow');
 const parentHistory=await read(w),childHistory=await read(child),a=activityRows(parentHistory),b=activityRows(childHistory);
 const files=a.filter(x=>x.name==='acquireSwansonFile'),ocr=b.filter(x=>x.name==='ocrFile'),closed=a.find(x=>x.name==='closeSwansonProductPage'),release=a.find(x=>x.name==='releaseResources');
 assert.equal(files.length,3);assert.equal(ocr.length,3);assert.equal(closed?.result.status,'closed');assert.ok(release?.completed>=closed.completed);
 for(let i=1;i<files.length;i++)assert.ok(files[i].started>=files[i-1].completed);
 for(const x of [...a,...b].filter(x=>!['reserveResources','releaseResources','verifyResourceReviewStopped'].includes(x.name))){assert.equal(x.maxAttempts,1);assert.equal(x.attempt,1);}
 const signals=childHistory.events.filter(e=>e.workflowExecutionSignaledEventAttributes).map(e=>({at:time(e),name:e.workflowExecutionSignaledEventAttributes.signalName,value:decode(e.workflowExecutionSignaledEventAttributes.input)}));
 for(const o of ocr){const f=files.find(f=>f.result.file.artifactId===o.input.file.artifactId);assert.ok(f);assert.deepEqual(f.result.file,o.input.file);assert.ok(o.started>=f.completed);
  const hint=signals.filter(s=>s.name==='channelSourceReady'&&s.value.file.artifactId===o.input.file.artifactId);assert.equal(hint.length,1);assert.deepEqual(hint[0].value.file,o.input.file);assert.ok(o.started>=hint[0].at);
 }
 const seal=signals.filter(s=>s.name==='channelStreamSealed');assert.equal(seal.length,1);assert.equal(seal[0].value.status,'closed');assert.ok(seal[0].at>=release.completed);
 const collections=b.filter(x=>x.name==='collectLabelProduct');if(child.result?.status==='collected'){assert.equal(collections.length,1);assert.ok(collections[0].started>=seal[0].at);}
 const lastFile=files.at(-1).completed,firstOcr=Math.min(...ocr.map(x=>x.started)),page=b.find(x=>x.name==='prepareHtmlPage');
 products.push({workflowId:w.workflowId,result:w.result.status,files:files.length,ocr:ocr.length,firstOcr:new Date(firstOcr).toISOString(),lastFile:new Date(lastFile).toISOString(),ocrBeforeAllFiles:firstOcr<lastFile,pageBeforeAllFiles:page.started<lastFile,closed:new Date(closed.completed).toISOString(),released:new Date(release.completed).toISOString(),collections:collections.length,allBusinessAttemptsOne:true,fileIdentityVerified:true});
}
assert.equal(products.length,2);assert.ok(products.some(p=>p.ocrBeforeAllFiles),'Real overlap must be observed');
const require=createRequire(root+'/package.json'),{Worker}=require('@temporalio/worker'),{Client,Connection}=require('@temporalio/client');
const r=JSON.parse(await fs.readFile(root+'/live/channel-resident-20260910-v2/swanson-brand-workflow.runtime.json')),t=r.transport;
const connection=await Connection.connect({address:r.address,tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
try{const client=new Client({connection,namespace:r.namespace});for(const w of report.workflows){
 // This installation's JSON-history converter has incompatible protobuf Type copies.
 // Re-read the same immutable history as SDK objects and compare with retained JSON.
 const history=await client.workflow.getHandle(w.workflowId,w.runId).fetchHistory();assert.deepEqual(JSON.parse(JSON.stringify(history)),await read(w));
 await Worker.runReplayHistory({workflowBundle:{codePath:root+'/release-channel-stream-20260910/product-workflows.cjs'}},history,w.workflowId);
}}finally{await connection.close();}
const proof={passed:true,at:new Date().toISOString(),requestId,products,replays:report.workflows.length,providerCalls:0};await fs.writeFile(dir+'/timeline.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
