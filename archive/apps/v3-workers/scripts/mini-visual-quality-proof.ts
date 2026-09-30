/** Bounded Mini acceptance: two vision turns, saved text, no new observation/product INSERT. */
import assert from "node:assert/strict";
import {hostname} from "node:os";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import pg from "pg";
import {Client,Connection} from "@temporalio/client";
import {NativeConnection,Worker} from "@temporalio/worker";
import {Context} from "@temporalio/activity";
import {LabelProductJoinSchema,VisionTaskSchema} from "@crawl-automation/v3-contracts";
import {createR2Objects} from "@crawl-automation/v3-artifacts";
import {channelLabelActivities} from "../integration/channel-label-activities.js";
import {readGncPrivateJson} from "../src/gnc-config.js";

async function main(){
 assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);assert.equal(process.env.V3_VISUAL_QUALITY_PROOF,"true");
 const[root,parentDir,firstDir,privatePath,runtimePath,failedDir]=process.argv.slice(2);assert.ok(root&&parentDir&&firstDir&&privatePath&&runtimePath);
 assert.equal(root,"/Users/barry/apps/crawlv3-channel-restored.PCrTm6/quality-batch-3");
 const json=async(p:string)=>JSON.parse(await readFile(p,"utf8"));const parent=await json(join(parentDir,"report.json")),first=await json(join(firstDir,"report.json"));assert.equal(parent.status,"passed");assert.equal(parent.parentId,first.id);
 const failed=failedDir?await json(join(failedDir,"report.json")):null;
 if(failed){assert.equal(failed.id,"visual-quality-ade3b034-e790-4a2a-a983-e8878e712f08");assert.equal(failed.status,"failed");assert.ok(failed.finishedAt);}
 const base=await readGncPrivateJson(privatePath) as any,runtime=await json(runtimePath),t=runtime.transport;
 assert.equal(base.r2.bucket,"supply-smart-test");assert.equal(new URL(base.reviewDatabase.connectionString).pathname,"/crawler_v3_test");
 const id=`visual-quality-${randomUUID()}`,dir=join(root,id);await mkdir(dir,{mode:0o700});
 const report:any={id,parentId:parent.id,browserProofId:first.browserProofId,status:"running",results:[],startedAt:new Date().toISOString(),providerCalls:{ocr:0,text:0,vision:0}};
 const save=()=>writeFile(join(dir,"report.json"),JSON.stringify(report,null,2),{mode:0o600});await save();
 const r2=createR2Objects({...base.r2,prefix:`${base.r2.prefix}/${first.browserProofId}`},base.r2Credentials),db=new pg.Pool({connectionString:base.reviewDatabase.connectionString,max:4});
 const resourceDb=base.resourceDatabase?new pg.Pool({connectionString:base.resourceDatabase.connectionString,max:2}):db;
 const products=async()=>(await db.query("SELECT operation_id,observation_id,record_hash FROM collected_product ORDER BY operation_id")).rows;
 report.productsBefore=await products();assert.equal(report.productsBefore.length,3);
 const tls={serverNameOverride:t.serverName,serverRootCACertificate:await readFile(t.caFile),clientCertPair:{crt:await readFile(t.certFile),key:await readFile(t.keyFile)}};
 let service:Awaited<ReturnType<typeof channelLabelActivities>>|undefined,connection:Connection|undefined,native:NativeConnection|undefined;
 const workers:Worker[]=[],runs:Promise<void>[]=[];const signal=()=>AbortSignal.timeout(30000);
 const readRemote=async(key:string)=>{const bytes=await r2.store.read(key,8388608,signal());assert.ok(bytes);return JSON.parse(Buffer.from(bytes).toString())};
 try{
  service=await channelLabelActivities({root:join(dir,"first"),remote:r2.store,db,resourceDb,storageId:"r2-channel-test/1",visionProtocol:"label-extraction/2"});await service.check();
  connection=await Connection.connect({address:runtime.address,tls});native=await NativeConnection.connect({address:runtime.address,tls});const client=new Client({connection,namespace:runtime.namespace}),bundle={codePath:join(root,"channel-label-proof/channel-label-workflows.cjs")};
  const launch=async(options:Parameters<typeof Worker.create>[0])=>{const w=await Worker.create(options);workers.push(w);const p=w.run();p.catch(()=>{});runs.push(p)};
  for(const name of ["interpretImage","assembleLabelProduct","collectLabelProduct"])await launch({connection:native,namespace:runtime.namespace,taskQueue:`${id}-${name}`,activities:{[name]:async(raw:any)=>{const c=Context.current(),e=c.info.workflowExecution!;const timer=setInterval(()=>c.heartbeat(),2000);try{return await service!.stops.run({workflowId:e.workflowId,runId:e.runId,activityId:c.info.activityId},name,raw,()=>service!.activities[name]!(raw,c.cancellationSignal))}finally{clearInterval(timer)}}},shutdownGraceTime:"10 seconds"});
  await launch({connection:native,namespace:runtime.namespace,taskQueue:`${id}-gate`,activities:Object.fromEntries(["reserveResources","releaseResources","verifyResourceReviewStopped"].map(name=>[name,(raw:any)=>service!.activities[name]!(raw,Context.current().cancellationSignal)])),shutdownGraceTime:"10 seconds"});
  await launch({connection:native,namespace:runtime.namespace,taskQueue:id,workflowBundle:bundle,shutdownGraceTime:"10 seconds"});
  const run=async(name:string,args:any,suffix:string)=>{const workflowId=`${id}-${suffix}`,h=await client.workflow.start(name,{workflowId,taskQueue:id,args:[args],workflowExecutionTimeout:"8 minutes"});const result=await h.result(),history=await h.fetchHistory();await Worker.runReplayHistory({workflowBundle:bundle},history);await writeFile(join(dir,`${suffix}-history.json`),JSON.stringify(history),{mode:0o600});return{workflowId,result,replayPassed:true}};
  const assembled:any[]=[];
  const assemble=async(input:any,suffix:string)=>{
   const parsed=LabelProductJoinSchema.parse(input),flow=await run("AssembleLabelJoinProbe",{join:parsed,queue:`${id}-assembleLabelProduct`},suffix),output=await readRemote(flow.result.evidenceKey);
   await writeFile(join(dir,`${suffix}.json`),JSON.stringify(output,null,2),{mode:0o600});assembled.push({input:parsed,flow,suffix});return{flow,output};
  };
  for(const p of parent.results){
   const saved=await json(join(parentDir,`${p.listingId}-assembly.json`)),original=LabelProductJoinSchema.parse(saved.input);
   const row:any={listingId:p.listingId};report.results.push(row);
   // Reassess genuine bad image candidates under new policy, never mutate old records.
   let control=original;
   if(p.listingId==="8572156346506"){
    const previous=await readRemote(first.results.find((r:any)=>r.listingId===p.listingId).result.evidenceKey),oldInput=LabelProductJoinSchema.parse(previous.input),image=oldInput.manifest.sources.find(s=>s.kind==="image")!;
    control=LabelProductJoinSchema.parse({...original,manifest:{...original.manifest,sources:[...original.manifest.sources.filter(s=>s.kind==="text"),image]},states:[...original.states.filter(s=>s.id!==image.id),{id:image.id,status:"registered"}]});
   }
   control=LabelProductJoinSchema.parse({...control,manifest:{...control.manifest,operationId:`${id}-${p.listingId}-control`,evidencePolicy:"label-image-first/4"}});
   const checked=await assemble(control,`${p.listingId}-control`);row.control=checked.flow;
   assert.equal(checked.output.result.status,p.listingId==="8572156018826"?"ready":"review");
   if(p.listingId==="8572156346506")assert.ok(checked.output.result.codes.includes("LABEL_PRODUCT.SOURCE_NUMERIC_CONFLICT"));
   else assert.equal(checked.output.result.formula.servingSize.citation.kind,"text");
   const image=original.manifest.sources.find(s=>s.kind==="image");assert.ok(image?.kind==="image");
   const task=VisionTaskSchema.parse({input:{...image.task.input,operationId:`${id}-${p.listingId}-vision`,extractionProtocol:"label-extraction/2"},configFingerprint:service.visionFingerprint});
   const args={task,queue:`${id}-interpretImage`,resources:{queue:`${id}-gate`,reviewStopCheck:true,maxWaitSeconds:240,activities:{interpretImage:[{resourceId:"mini-model-account",units:1},{resourceId:"mini-cpu",units:1}]}}};
   const preserveFailed=failed&&p.listingId==="8572156018826";
   if(preserveFailed){row.vision=failed.results.find((r:any)=>r.listingId===p.listingId).vision;row.preservedFailedVision=true;assert.equal(row.vision.result.code,"VISION.HANDOFF_PENDING");}
   else row.vision=await run("VisionQualityProbe",args,`${p.listingId}-vision`);await save();
   assert.ok(["registered","review"].includes(row.vision.result.status));
   const next=preserveFailed?LabelProductJoinSchema.parse({...control,manifest:{...control.manifest,operationId:`${id}-${p.listingId}-candidate`}}):LabelProductJoinSchema.parse({...original,manifest:{...original.manifest,operationId:`${id}-${p.listingId}-candidate`,evidencePolicy:"label-image-first/4",sources:original.manifest.sources.map(s=>s.id===image.id?{...s,task}:s)},states:original.states.map(s=>s.id===image.id?(row.vision.result.status==="registered"?{id:s.id,status:"registered"}:{id:s.id,status:"review",reviewId:row.vision.result.reviewId}):s)});
   const out=await assemble(next,`${p.listingId}-candidate`);row.assembly=out.flow;
   row.fields={formula:out.output.result.formula,otherIngredients:out.output.result.otherIngredients,warnings:out.output.result.warnings,codes:out.output.result.codes};
   if(out.flow.result.status==="ready"){
    // Only known existing observations; collector must retain-first and return an explicit relation.
    assert.ok(await service.collection.readObservation(next.manifest.observation.observationId));
    row.collection=await run("CollectQualityProbe",{input:{join:next,evidenceKey:out.flow.result.evidenceKey},queue:`${id}-collectLabelProduct`},`${p.listingId}-collection`);
    assert.deepEqual(row.collection.result.codes,["LABEL_COLLECTION.OBSERVATION_ALREADY_COLLECTED"]);
    const review=(await db.query("SELECT record FROM review_record WHERE review_id=$1",[row.collection.result.reviewId])).rows[0].record;
    assert.ok(review.rawError.details.existingCollection.operationId);await writeFile(join(dir,`${p.listingId}-collection-review.json`),JSON.stringify(review,null,2),{mode:0o600});
    const intent=await r2.store.read(`v3/label-products/${next.manifest.operationId}/collection-intent.json`,65536,signal());assert.equal(intent,null);
   }
   row.visionArgs=args;await save();
  }
  report.providerCalls={...service.counts};assert.deepEqual(report.providerCalls,{ocr:0,text:0,vision:failed?1:2});await service.close();
  service=await channelLabelActivities({root:join(dir,"cold"),remote:r2.store,db,resourceDb,storageId:"r2-channel-test/1",visionProtocol:"label-extraction/2",readOnlyProviders:true});
  for(const item of assembled){const cold=await run("AssembleLabelJoinProbe",{join:item.input,queue:`${id}-assembleLabelProduct`},`${item.suffix}-cold`);assert.deepEqual(cold.result,item.flow.result);}
  for(const row of report.results){
   if(row.vision.result.status==="registered"){const cold=await run("VisionQualityProbe",row.visionArgs,`${row.listingId}-vision-cold`);assert.deepEqual(cold.result,row.vision.result);row.coldVision=cold;}
   if(row.collection){const item=assembled.find(p=>p.suffix===`${row.listingId}-candidate`)!;const cold=await run("CollectQualityProbe",{input:{join:item.input,evidenceKey:item.flow.result.evidenceKey},queue:`${id}-collectLabelProduct`},`${row.listingId}-collection-cold`);assert.deepEqual(cold.result,row.collection.result);row.coldCollection=cold;}
   delete row.visionArgs;
  }
  report.coldProviderCalls={...service.counts};assert.deepEqual(report.coldProviderCalls,{ocr:0,text:0,vision:0});
  report.productsAfter=await products();assert.deepEqual(report.productsAfter,report.productsBefore);
  report.counts=(await db.query("SELECT (SELECT count(*)::int FROM collected_product) collected,(SELECT count(*)::int FROM review_record) reviews")).rows[0];report.counts.held=(await resourceDb.query("SELECT count(*)::int AS held FROM resource_permit WHERE released_at IS NULL")).rows[0].held;assert.equal(report.counts.held,0);
  report.status="passed";
 }catch(e){report.status="failed";report.error=e instanceof Error&&/^[A-Z0-9_.]+$/.test(e.message)?e.message:"INSPECT_EVIDENCE";process.exitCode=1}
 finally{if(service&&!report.coldProviderCalls)report.providerCalls={...service.counts};await service?.close();for(const w of workers)if(w.getState()==="RUNNING")w.shutdown();await Promise.allSettled(runs);await native?.close();await connection?.close();if(resourceDb!==db)await resourceDb.end();await db.end();r2.close();report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({event:"VISUAL_QUALITY_FINISHED",report:join(dir,"report.json"),status:report.status,providerCalls:report.providerCalls}))}
}
main().catch(()=>{console.error("VISUAL_QUALITY_START_REJECTED");process.exitCode=1});
