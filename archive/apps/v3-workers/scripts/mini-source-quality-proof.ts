/** Saved evidence only: new product decisions, old Review/observations untouched.
 * Four atomic queues; no OCR/browser/model Activity is registered. */
import assert from "node:assert/strict";
import {hostname} from "node:os";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {randomUUID} from "node:crypto";
import pg from "pg";
import {Client,Connection} from "@temporalio/client";
import {Worker,NativeConnection} from "@temporalio/worker";
import {Context} from "@temporalio/activity";
import {LabelProductJoinSchema,LabelCoreOutcomeSchema} from "@crawl-automation/v3-contracts";
import {createR2Objects} from "@crawl-automation/v3-artifacts";
import {parseWorkerConfig} from "@crawl-automation/v3-worker-runtime";
import {readGncPrivateJson} from "../src/gnc-config.js";
import {channelLabelActivities} from "../integration/channel-label-activities.js";
async function main(){
 assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);assert.equal(process.env.V3_SOURCE_QUALITY_PROOF,"true");
 const[rootArg,parentArg,privatePath,runtimePath,reconcileDir]=process.argv.slice(2);assert.ok(rootArg&&parentArg&&privatePath&&runtimePath);
 const root=resolve(rootArg),parent=JSON.parse(await readFile(join(resolve(parentArg),"report.json"),"utf8"));
 assert.equal(parent.status,"review");assert.equal(parent.results.length,2);assert.ok(parent.finishedAt);
 if(reconcileDir){assert.match(resolve(reconcileDir),/^\/Users\/barry\/apps\/crawlv3-channel-restored\.PCrTm6\/source-quality-v1\/source-quality-[a-f0-9-]+$/);const prior=JSON.parse(await readFile(join(reconcileDir,"report.json"),"utf8"));assert.equal(prior.status,"failed");assert.equal(prior.parentProofId,parent.id);assert.ok(prior.finishedAt);}
 const base=await readGncPrivateJson(privatePath) as any,runtime=parseWorkerConfig(JSON.parse(await readFile(runtimePath,"utf8")));
 assert.equal(base.r2.bucket,"supply-smart-test");assert.equal(new URL(base.reviewDatabase.connectionString).pathname,"/crawler_v3_test");assert.equal(runtime.namespace,parent.namespace);assert.equal(runtime.transport.mode,"mtls");if(runtime.transport.mode!=="mtls")throw Error();
 const id=`source-quality-${randomUUID()}`,dir=join(root,id);await mkdir(dir,{mode:0o700});
 const report:any={id,parentProofId:parent.id,browserProofId:parent.browserProofId,reconcileDir,status:"running",startedAt:new Date().toISOString(),results:[],cores:[],providerCalls:{ocr:0,text:0,vision:0},browserCalls:0,oldReviewsModified:0};
 const save=()=>writeFile(join(dir,"report.json"),JSON.stringify(report,null,2),{mode:0o600});await save();
 const r2=createR2Objects({...base.r2,prefix:`${base.r2.prefix}/${parent.browserProofId}`},base.r2Credentials),db=new pg.Pool({connectionString:base.reviewDatabase.connectionString,max:3});
 let service:Awaited<ReturnType<typeof channelLabelActivities>>|undefined,connection:Connection|undefined,native:NativeConnection|undefined;
 const workers:Worker[]=[],runs:Promise<void>[]=[];
 try{
  service=await channelLabelActivities({root:join(dir,"first"),remote:r2.store,db,storageId:"r2-channel-test/1",readOnlyProviders:true});
  const t=runtime.transport,tls={serverNameOverride:t.serverName,serverRootCACertificate:await readFile(t.caFile),clientCertPair:{crt:await readFile(t.certFile),key:await readFile(t.keyFile)}};
  connection=await Connection.connect({address:runtime.address,tls,connectTimeout:"15 seconds"});native=await NativeConnection.connect({address:runtime.address,tls});
  const client=new Client({connection,namespace:runtime.namespace}),bundle={codePath:join(root,"channel-label-proof/channel-label-workflows.cjs")};
  const launch=async(options:Parameters<typeof Worker.create>[0])=>{const w=await Worker.create(options);workers.push(w);const p=w.run();p.catch(()=>{});runs.push(p)};
  for(const name of["assembleLabelProduct","collectLabelProduct","prepareSwansonLabelCore"]){await launch({connection:native,namespace:runtime.namespace,taskQueue:`${id}-${name}`,activities:{[name]:async(raw:unknown)=>{const c=Context.current();assert.equal(c.info.attempt,1);const timer=setInterval(()=>c.heartbeat(),2000);try{return await service!.activities[name]!(raw,c.cancellationSignal)}finally{clearInterval(timer)}}},shutdownGraceTime:"5 seconds"})}
  await launch({connection:native,namespace:runtime.namespace,taskQueue:id,workflowBundle:bundle,shutdownGraceTime:"5 seconds"});
  for(const old of parent.results){
   assert.equal(old.result.status,"review");assert.equal(old.result.evidenceKey,`v3/label-products/${old.operationId}/assembly.json`);
   const bytes=await r2.store.read(old.result.evidenceKey,8*1024*1024,AbortSignal.timeout(30000));assert.ok(bytes);
   const previous=LabelProductJoinSchema.parse(JSON.parse(Buffer.from(bytes).toString()).input);assert.equal(previous.manifest.operationId,old.operationId);assert.equal(previous.manifest.observation.listingId,old.listingId);
   const next=LabelProductJoinSchema.parse(reconcileDir?JSON.parse(await readFile(join(reconcileDir,`${old.listingId}-input.json`),"utf8")):{...previous,manifest:{...previous.manifest,operationId:`${id}-${old.listingId}`,evidencePolicy:"label-image-first/2"}});
   assert.deepEqual(next,{...previous,manifest:{...previous.manifest,operationId:next.manifest.operationId,evidencePolicy:"label-image-first/2"}});
   await writeFile(join(dir,`${old.listingId}-input.json`),JSON.stringify(next,null,2),{mode:0o600});
   const run=async(name:string,args:unknown,suffix:string)=>{const workflowId=`${id}-${old.listingId}-${suffix}`,h=await client.workflow.start(name,{workflowId,taskQueue:id,args:[args],workflowExecutionTimeout:"3 minutes"});
    const result=await h.result(),history=await h.fetchHistory();await Worker.runReplayHistory({workflowBundle:bundle},history);await writeFile(join(dir,`${old.listingId}-${suffix}-history.json`),JSON.stringify(history),{mode:0o600});return{workflowId,result,replayPassed:true}};
   const text=previous.manifest.sources.find(s=>s.kind==="text");assert.ok(text?.kind==="text"&&text.task.source.kind==="prepared");
   const core=await run("SwansonCoreProbe",{input:{owner:previous.manifest.observation,fullDocument:text.task.source.document},queue:`${id}-prepareSwansonLabelCore`},"core");
   LabelCoreOutcomeSchema.parse(core.result);report.cores.push(core);await save();
   const result=await run("SavedQualityJoinWorkflow",{join:next,queues:{assembly:`${id}-assembleLabelProduct`,collection:`${id}-collectLabelProduct`}},"join");
   const record=await service.collection.read(next.manifest.operationId);
   if(record)await writeFile(join(dir,`${old.listingId}-collected.json`),JSON.stringify(record,null,2),{mode:0o600});
   assert.deepEqual(service.counts,{ocr:0,text:0,vision:0});await service.close();
   service=await channelLabelActivities({root:join(dir,`cold-${old.listingId}`),remote:r2.store,db,storageId:"r2-channel-test/1",readOnlyProviders:true});
   const cold=await run("SavedQualityJoinWorkflow",{join:next,queues:{assembly:`${id}-assembleLabelProduct`,collection:`${id}-collectLabelProduct`}},"cold");
   assert.deepEqual(cold.result,result.result);assert.deepEqual(await service.collection.read(next.manifest.operationId),record);
   report.results.push({...result,listingId:old.listingId,registered:!!record,cold});await save();console.log(JSON.stringify({event:"SOURCE_QUALITY_RESULT",...report.results.at(-1)}));
  }
  report.providerCalls={...service.counts};assert.deepEqual(report.providerCalls,{ocr:0,text:0,vision:0});
  assert.equal(report.results.find((r:any)=>r.listingId==="8572156018826")?.result.status,"collected");
  assert.equal(report.results.find((r:any)=>r.listingId==="8572156346506")?.result.status,"review");
  report.status="passed";
 }catch(error){report.status="failed";report.error=error instanceof Error&&/^[A-Z0-9_.]+$/.test(error.message)?error.message:"INSPECT_EVIDENCE";process.exitCode=1}
 finally{await service?.close();for(const w of workers)if(w.getState()==="RUNNING")w.shutdown();await Promise.allSettled(runs);await native?.close();await connection?.close();await db.end();r2.close();report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({event:"SOURCE_QUALITY_FINISHED",report:join(dir,"report.json"),status:report.status,error:report.error}))}
}
main().catch(()=>{console.error("SOURCE_QUALITY_START_REJECTED");process.exitCode=1});
