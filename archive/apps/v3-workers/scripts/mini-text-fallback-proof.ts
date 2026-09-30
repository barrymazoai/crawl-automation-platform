/** Two new text turns only, saved-image fallback, no product INSERT or image provider. */
import assert from "node:assert/strict";
import {hostname} from "node:os";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import pg from "pg";
import {Client,Connection} from "@temporalio/client";
import {NativeConnection,Worker} from "@temporalio/worker";
import {Context} from "@temporalio/activity";
import {LabelProductJoinSchema,TextInputSchema,textFingerprint} from "@crawl-automation/v3-contracts";
import {createR2Objects,sha256} from "@crawl-automation/v3-artifacts";
import {channelLabelActivities} from "../integration/channel-label-activities.js";
import {readGncPrivateJson} from "../src/gnc-config.js";
async function main(){
 assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);assert.equal(process.env.V3_TEXT_FALLBACK_PROOF,"true");
 const[root,parentDir,oldDir,privatePath,runtimePath]=process.argv.slice(2);assert.ok(root&&parentDir&&oldDir&&privatePath&&runtimePath);
 const json=async(p:string)=>JSON.parse(await readFile(p,"utf8")),parent=await json(join(parentDir,"report.json")),old=await json(join(oldDir,"report.json"));assert.ok(parent.finishedAt&&old.finishedAt);assert.equal(parent.browserProofId,old.browserProofId);
 const base=await readGncPrivateJson(privatePath) as any,runtime=await json(runtimePath),t=runtime.transport;assert.equal(base.r2.bucket,"supply-smart-test");assert.equal(new URL(base.reviewDatabase.connectionString).pathname,"/crawler_v3_test");
 const id=`text-fallback-${randomUUID()}`,dir=join(root,id);await mkdir(dir,{mode:0o700});
 const report:any={id,parentId:parent.id,status:"running",results:[],providerCalls:{ocr:0,text:0,vision:0},startedAt:new Date().toISOString(),productWrites:0};
 const save=()=>writeFile(join(dir,"report.json"),JSON.stringify(report,null,2),{mode:0o600});await save();
 const r2=createR2Objects({...base.r2,prefix:`${base.r2.prefix}/${parent.browserProofId}`},base.r2Credentials),db=new pg.Pool({connectionString:base.reviewDatabase.connectionString,max:4});
 const tls={serverNameOverride:t.serverName,serverRootCACertificate:await readFile(t.caFile),clientCertPair:{crt:await readFile(t.certFile),key:await readFile(t.keyFile)}};
 let service:Awaited<ReturnType<typeof channelLabelActivities>>|undefined,connection:Connection|undefined,native:NativeConnection|undefined;
 const workers:Worker[]=[],runs:Promise<void>[]=[];
 try{
  service=await channelLabelActivities({root:join(dir,"first"),remote:r2.store,db,storageId:"r2-channel-test/1"});await service.check();
  connection=await Connection.connect({address:runtime.address,tls});native=await NativeConnection.connect({address:runtime.address,tls});const client=new Client({connection,namespace:runtime.namespace}),bundle={codePath:join(root,"channel-label-proof/channel-label-workflows.cjs")};
  const launch=async(options:Parameters<typeof Worker.create>[0])=>{const w=await Worker.create(options);workers.push(w);const p=w.run();p.catch(()=>{});runs.push(p)};
  const names=["interpretText","resolveTextReceipt","assembleLabelProduct","reserveResources","releaseResources","verifyResourceReviewStopped"];
  for(const name of names.slice(0,3))await launch({connection:native,namespace:runtime.namespace,taskQueue:`${id}-${name}`,activities:{[name]:async(raw:any)=>{const c=Context.current(),e=c.info.workflowExecution!;const timer=setInterval(()=>c.heartbeat(),2000);try{return await service!.stops.run({workflowId:e.workflowId,runId:e.runId,activityId:c.info.activityId},name,raw,()=>service!.activities[name]!(raw,c.cancellationSignal))}finally{clearInterval(timer)}}},shutdownGraceTime:"10 seconds"});
  // Resource gate expects reserve/release/verifier on one queue.
  await launch({connection:native,namespace:runtime.namespace,taskQueue:`${id}-gate`,activities:Object.fromEntries(names.slice(3).map(name=>[name,(raw:any)=>service!.activities[name]!(raw,Context.current().cancellationSignal)])),shutdownGraceTime:"10 seconds"});
  await launch({connection:native,namespace:runtime.namespace,taskQueue:id,workflowBundle:bundle,shutdownGraceTime:"10 seconds"});
  const run=async(name:string,args:any,suffix:string)=>{const workflowId=`${id}-${suffix}`,h=await client.workflow.start(name,{workflowId,taskQueue:id,args:[args],workflowExecutionTimeout:"8 minutes"});const result=await h.result(),history=await h.fetchHistory();await Worker.runReplayHistory({workflowBundle:bundle},history);await writeFile(join(dir,`${suffix}-history.json`),JSON.stringify(history),{mode:0o600});return{workflowId,result,replayPassed:true}};
  const newJoins:any[]=[];
  for(const p of parent.results.filter((r:any)=>r.workflowId.endsWith("-first"))){
   const b=await r2.store.read(p.result.evidenceKey,8388608,AbortSignal.timeout(30000));assert.ok(b);const original=LabelProductJoinSchema.parse(JSON.parse(Buffer.from(b).toString()).input),source=original.manifest.sources.find(s=>s.kind==="text");assert.ok(source?.kind==="text");
   const unsigned={...source.task,...service.text,operationId:`${id}-${p.listingId}-text`},task=TextInputSchema.parse({...unsigned,inputFingerprint:textFingerprint(unsigned,s=>sha256(Buffer.from(s)))});
   const args={text:{task,queues:{text:`${id}-interpretText`,receipts:`${id}-resolveTextReceipt`}},resources:{queue:`${id}-gate`,reviewStopCheck:true,maxWaitSeconds:240,activities:{interpretText:[{resourceId:"mini-model-account",units:1},{resourceId:"mini-cpu",units:1}]}}};
   const text=await run("TextQualityProbe",args,`${p.listingId}-text`);report.results.push({listingId:p.listingId,text});await save();
   if(text.result.status!=="registered")continue;
   let joined=LabelProductJoinSchema.parse({...original,manifest:{...original.manifest,operationId:`${id}-${p.listingId}-assembly`,sources:original.manifest.sources.map(s=>s.kind==="text"?{...s,task}:s)},states:original.states.map(s=>s.id===source.id?{id:s.id,status:"registered"}:s)});
   if(p.listingId==="8572156346506"){
    const op=old.results.find((r:any)=>r.listingId===p.listingId),bytes=await r2.store.read(op.result.evidenceKey,8388608,AbortSignal.timeout(30000));assert.ok(bytes);const previous=LabelProductJoinSchema.parse(JSON.parse(Buffer.from(bytes).toString()).input);
    const images=previous.manifest.sources.filter(s=>s.kind==="image");assert.equal(images.length,1);
    joined=LabelProductJoinSchema.parse({...joined,manifest:{...joined.manifest,sources:[...joined.manifest.sources.filter(s=>s.kind==="text"),...images]},states:[...joined.states.filter(s=>s.id===source.id),...previous.states.filter(s=>images.some(i=>i.id===s.id))]});
   }
   const assembly=await run("AssembleLabelJoinProbe",{join:joined,queue:`${id}-assembleLabelProduct`},`${p.listingId}-assembly`);
   report.results.at(-1).assembly=assembly;await writeFile(join(dir,`${p.listingId}-input.json`),JSON.stringify(joined,null,2),{mode:0o600});
   const output=await r2.store.read(assembly.result.evidenceKey,8388608,AbortSignal.timeout(30000));assert.ok(output);await writeFile(join(dir,`${p.listingId}-assembly.json`),output,{mode:0o600});newJoins.push({listingId:p.listingId,args,join:joined,assembly});await save();
  }
  report.providerCalls={...service.counts};assert.equal(report.providerCalls.vision,0);assert.equal(report.providerCalls.ocr,0);await service.close();
  service=await channelLabelActivities({root:join(dir,"cold"),remote:r2.store,db,storageId:"r2-channel-test/1",readOnlyProviders:true});
  for(const p of newJoins){const text=await run("TextQualityProbe",p.args,`${p.listingId}-cold-text`),assembly=await run("AssembleLabelJoinProbe",{join:p.join,queue:`${id}-assembleLabelProduct`},`${p.listingId}-cold-assembly`);assert.equal(text.result.status,"registered");assert.deepEqual(assembly.result,p.assembly.result);report.results.find((r:any)=>r.listingId===p.listingId).cold={text,assembly};}
  report.coldProviderCalls={...service.counts};report.status=newJoins.length===2&&newJoins.every(p=>p.assembly.result.status==="ready")?"passed":"review";
 }catch(e){report.status="failed";report.error=e instanceof Error&&/^[A-Z0-9_.]+$/.test(e.message)?e.message:"INSPECT_EVIDENCE";process.exitCode=1}
 finally{await service?.close();for(const w of workers)if(w.getState()==="RUNNING")w.shutdown();await Promise.allSettled(runs);await native?.close();await connection?.close();await db.end();r2.close();report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({event:"TEXT_FALLBACK_FINISHED",report:join(dir,"report.json"),status:report.status,providerCalls:report.providerCalls}))}
}
main().catch(()=>{console.error("TEXT_FALLBACK_START_REJECTED");process.exitCode=1});
