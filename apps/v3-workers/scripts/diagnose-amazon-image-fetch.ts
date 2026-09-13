/** Bounded Mini-only investigation. No business submission or Review replay. */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {Client,Connection} from '@temporalio/client';
import {defaultPayloadConverter} from '@temporalio/common';
import {createR2Objects,sha256} from '@crawl-automation/v3-artifacts';
import {PostgresResourceAdmission} from '../../../packages/v3-product/src/resource-admission.js';
import {EgoCliRunner,EgoTaskPages,EgoFileTransport} from '@crawl-automation/v3-acquisition';
import {TextLocalStore} from '@crawl-automation/v3-text';
import {AmazonEgoReader} from '@crawl-automation/v3-channels';
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',five='/Users/barry/apps/crawlv3-history-20260913/amazon-5-us-20260913',dir='/Users/barry/apps/crawlv3-history-20260913/amazon-image-network-diagnostic-20260913';
const read=async(p:string)=>JSON.parse(await fs.readFile(p,'utf8'));
const save=async(n:string,v:unknown)=>fs.writeFile(dir+'/'+n,JSON.stringify(v,null,2),{mode:0o600,flag:'wx'});
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const mode=process.argv[2],asin=process.argv[3];
await fs.mkdir(dir,{recursive:true,mode:0o700});
const m=await read(main+'/live/deployment.json'),c=await read(m.jobs.find((j:any)=>j.id==='amazon-capture').env.V3_AMAZON_LIVE_CONFIG);
const db=new pg.Pool({connectionString:c.database.connectionString,max:1,connectionTimeoutMillis:5000,statement_timeout:5000});
const admission=new PostgresResourceAdmission(db),runner=new EgoCliRunner(),pages=new EgoTaskPages(c.browser,await TextLocalStore.open(dir+'/pages'));
const call=(s:string,ms=30000)=>runner.run(c.browser.cliPath,s,AbortSignal.timeout(ms));
try{
 if(mode==='extract'){
  const r=await read(m.jobs.find((j:any)=>j.id==='amazon-brand-workflow').env.V3_WORKER_CONFIG),t=r.transport;
  const connection=await Connection.connect({address:r.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
  const r2=createR2Objects(c.r2,c.r2Credentials);
  try{
   const client=new Client({connection,namespace:r.namespace}),plan=await read(five+'/temporal-plan.json'),rows=(await db.query('select record from catalog_discovery where catalog_id=ANY($1)',[plan.batches.map((b:any)=>b.requestId)])).rows;
   const result=[];
   for(const {record:d} of rows){
    const handle=client.workflow.getHandle(d.workflowId);assert.equal((await handle.describe()).status.name,'COMPLETED');
    const events=(await handle.fetchHistory()).events??[],scheduled=events.filter(e=>e.activityTaskScheduledEventAttributes?.activityType?.name==='acquireAmazonFile');
    const e=scheduled[0]!;assert.ok(e);
    const input:any=defaultPayloadConverter.fromPayload(e.activityTaskScheduledEventAttributes!.input!.payloads![0]!);
    const key=`v3/channel-plans/${input.sourcePlan.operationId}/plan.json`;
    const raw=await r2.store.read(key,8*1024*1024,AbortSignal.timeout(15000));assert.ok(raw);
    const retained=JSON.parse(Buffer.from(raw).toString());assert.deepEqual(retained.input,input.sourcePlan);
    assert.ok(retained.manifest.sources.some((s:any)=>s.kind==='file-image'&&JSON.stringify(s.plan.acquire)===JSON.stringify(input.input)));
    const file=retained.files.find((f:any)=>f.resourceId===input.input.resourceId);assert.ok(file);
    const end=events.find(x=>x.activityTaskCompletedEventAttributes?.scheduledEventId?.toString()===e.eventId?.toString());
    const outcome=end?defaultPayloadConverter.fromPayload(end.activityTaskCompletedEventAttributes!.result!.payloads![0]!):null;
    result.push({asin:d.entry.listingId,url:d.entry.url,workflowId:d.workflowId,imageUrl:file.url,resourceId:file.resourceId,operationId:input.input.operationId,planKey:key,planSha256:sha256(raw),outcome});
   }
   await save('inputs.json',result);console.log(JSON.stringify(result));
  }finally{r2.close();await connection.close();}
 }else if(mode==='projections'){
  const r2=createR2Objects(c.r2,c.r2Credentials);
  try{const result=[];for(const input of await read(dir+'/inputs.json')){
   const planBytes=await r2.store.read(input.planKey,8*1024*1024,AbortSignal.timeout(15000));assert.ok(planBytes);assert.equal(sha256(planBytes),input.planSha256);
   const plan=JSON.parse(Buffer.from(planBytes).toString()),ref=plan.input.source,bytes=await r2.store.read(ref.objectKey,ref.byteSize,AbortSignal.timeout(15000));assert.ok(bytes);assert.equal(bytes.length,ref.byteSize);assert.equal(sha256(bytes),ref.sha256);
   const p=JSON.parse(Buffer.from(bytes).toString());result.push({asin:input.asin,expectedUrl:plan.input.expectedUrl,actualCapturedUrl:p.url,canonicalUrl:p.canonicalUrl,capturedAt:p.capturedAt,sourceKey:ref.objectKey,sourceSha256:ref.sha256,firstImage:p.gallery[0],originalOutcome:input.outcome.status});
  }await save('original-projections.json',result);console.log(JSON.stringify(result));}finally{r2.close();}
 }else if(mode==='open'){
  const source=(await read(dir+'/inputs.json')).find((s:any)=>s.asin===asin);assert.ok(source);
  const taskId='image-diagnostic-'+asin+'-'+randomUUID(),request={permitId:taskId,workflowId:taskId,runId:randomUUID(),needs:[{resourceId:c.browserResource,units:1}]};
  // workflowId is a diagnostic owner identity, explicitly not a Temporal business Workflow.
  await save(asin+'-intent.json',{kind:'bounded-browser-diagnostic',taskId,request,source});
  const decision=await admission.reserve(request);assert.equal(decision.status,'granted');
  const browser=await pages.open(taskId,AbortSignal.timeout(20000));await save(asin+'-page.json',{taskId,request,source,browser});
  const projection=await new AmazonEgoReader(browser).product(source.url,AbortSignal.timeout(150000),undefined,'10001');
  await save(asin+'-projection.json',projection);console.log(JSON.stringify({asin,taskId,targetId:browser.targetId,gallery:projection.gallery}));
 }else if(mode==='transport'){
  const state=await read(dir+'/'+asin+'-page.json'),projection=await read(dir+'/'+asin+'-projection.json');assert.equal(projection.asin,asin);
  await admission.requireHeld(c.browserResource,state.request.workflowId,state.request.runId);
  const results=[];
  for(const pageUrl of [...new Set<string>([state.source.url,projection.url])]){
   const transport=new EgoFileTransport({browser:state.browser,pageUrl,allowedUrls:[state.source.imageUrl]},c.egressId),at=Date.now();
   try{const response=await transport.get(new URL(state.source.imageUrl),undefined,{},AbortSignal.timeout(35000));try{const chunks=[];for await(const chunk of response.body)chunks.push(chunk);const bytes=Buffer.concat(chunks);results.push({pageUrl,ok:true,status:response.status,byteSize:bytes.length,sha256:sha256(bytes),elapsedMs:Date.now()-at});}finally{response.close();}}
   catch(error){const e=error as Error&{code?:string};results.push({pageUrl,ok:false,error:{name:e.name,message:e.message,code:e.code},elapsedMs:Date.now()-at});}
  }
  await save(asin+'-transport.json',{asin,targetId:state.browser.targetId,imageUrl:state.source.imageUrl,results});console.log(JSON.stringify(results));
 }else if(mode==='probe'){
  const state=await read(dir+'/'+asin+'-page.json'),variant=process.argv[4]??'baseline';assert.ok(['baseline','observed-baseline','reload','no-store'].includes(variant));
  const projection=await read(dir+'/'+asin+'-projection.json');assert.equal(projection.asin,asin);
  const pageUrl=variant==='baseline'?state.source.url:projection.url;
  await admission.requireHeld(c.browserResource,state.request.workflowId,state.request.runId);
  const expression=`(async()=>{const url=${JSON.stringify(state.source.imageUrl)},start=performance.now(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);let phase='fetch',responseInfo=null;try{if(location.href!==${JSON.stringify(pageUrl)}||document.querySelector('#ASIN')?.value!==${JSON.stringify(asin)})throw Error('DIAGNOSTIC_IDENTITY_CHANGED');const response=await fetch(url,{method:'GET',credentials:'same-origin',redirect:'error',signal:controller.signal${variant.endsWith('baseline')?'':`,cache:${JSON.stringify(variant)}`}});responseInfo={url:response.url,type:response.type,status:response.status,redirected:response.redirected,headers:Object.fromEntries([...response.headers].filter(([k])=>['content-type','content-length','access-control-allow-origin','vary','cache-control','etag'].includes(k)))};phase='verify';if(response.type==='opaque'||response.redirected||response.url!==url)throw Error('EGO_RESPONSE_UNVERIFIED');phase='read';const reader=response.body?.getReader(),chunks=[];let length=0;if(reader)try{while(true){const r=await reader.read();if(r.done)break;length+=r.value.length;if(length>4194304)throw Error('EGO_FILE_LIMIT');chunks.push(r.value)}}finally{phase='cancel-reader';await reader.cancel()}phase='digest';const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}const digest=await crypto.subtle.digest('SHA-256',bytes);return {ok:true,bytes:length,sha256:[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join(''),responseInfo,elapsedMs:performance.now()-start}}catch(error){return{ok:false,phase,error:{name:error?.name,message:error?.message,stack:error?.stack},responseInfo,elapsedMs:performance.now()-start}}finally{clearTimeout(timer);controller.abort()}})()`;
  const script=`await useOrCreateTaskSpace(1);const tabs=await listTabs();const selected=tabs.filter(t=>t.targetId===${JSON.stringify(state.browser.targetId)}&&t.url===${JSON.stringify(pageUrl)});if(selected.length!==1)throw Error('TARGET_MISMATCH');await switchTab(selected[0].targetId);await cdp('Network.enable',{});await cdp('Log.enable',{});await drainEvents();const result=await js(${JSON.stringify(expression)});const events=await drainEvents();const snapshot={at:new Date().toISOString(),pageUrl:${JSON.stringify(pageUrl)},result,events};`;
  const wrapped=`const snapshot=await(async()=>{${script.replace('const snapshot={at:', 'return {at:')}})().catch(error=>({cliError:{name:error?.name,message:error?.message,stack:error?.stack}}));`;
  const out:any=await call(wrapped,35000);
  // Keep raw event structures private for inspection; no cookies or headers printed to the transcript.
  await save(asin+'-'+variant+'-'+Date.now()+'.private.json',out);
  console.log(JSON.stringify({asin,variant,result:out.result,cliError:out.cliError,eventShape:Array.isArray(out.events)?out.events.slice(0,3).map((e:any)=>({keys:Object.keys(e),method:e.method,type:e.type})):typeof out.events,eventCount:Array.isArray(out.events)?out.events.length:null}));
 }else if(mode==='close'){
  const state=await read(dir+'/'+asin+'-page.json');
  const closed=await pages.close(state.taskId,AbortSignal.timeout(20000)),checks=[];
  for(let n=0;n<3;n++){const out:any=await call('await useOrCreateTaskSpace(1);const snapshot={tabs:await listTabs()};',15000);assert.ok(out.tabs.every((t:any)=>t.targetId!==state.browser.targetId));checks.push({at:new Date().toISOString(),targetsAbsent:true});}
  await save(asin+'-cleanup.json',{closed,checks});const released=await admission.release(state.request);console.log(JSON.stringify({closed,checks,released}));
 }else throw Error('unknown diagnostic mode');
}finally{await db.end();}
