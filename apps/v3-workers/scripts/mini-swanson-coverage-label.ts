import assert from "node:assert/strict";
import {hostname} from "node:os";
import {join} from "node:path";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import pg from "pg";
import {Client,Connection} from "@temporalio/client";
import {Worker,NativeConnection} from "@temporalio/worker";
import {createR2Objects,sha256} from "@crawl-automation/v3-artifacts";
import {ChannelLabelInputSchema,ChannelSavedLabelWorkflowInputSchema} from "@crawl-automation/v3-contracts";
import {readGncPrivateJson} from "../src/gnc-config.js";
import {channelLabelRole,channelLabelRoutes} from "../src/channel-label-role.js";
import {runChannelLabelActivity} from "../src/channel-label-execution.js";

// One finite, new pair of label workflows, using existing provider settings.
// Every atomic role has its own queue; this is an acceptance harness, not a resident deployment.
async function main(){
 assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);assert.equal(process.argv[2],"--bounded-label-proof");
 const root="/Users/barry/apps/crawlv3-batch-a.UiA4dx",sourceDir=process.argv[3]!,resident=root+"/live/channel-resident-20260910-v2";
 assert.match(sourceDir,new RegExp("^"+root.replaceAll(".","\\.")+"/live/swanson-coverage-[a-f0-9-]{36}$"));
 const read=async(p:string)=>JSON.parse(await readFile(p,"utf8")),browser=await read(sourceDir+"/report.json");
 assert.equal(browser.status,"passed");assert.equal(browser.browserPermitReleased,true);assert.equal(browser.products.length,2);assert.equal(browser.family.coverage,"declared-options");assert.ok(browser.products.every((p:any)=>p.browserPageClosed));
 const generation=process.argv[4]??"label";assert.match(generation,/^label(?:-[0-9]{8})?$/);
 const dir=sourceDir+"/"+generation;await mkdir(dir,{mode:0o700}); // wx-equivalent: never restart this batch by re-running the script.
 const base=await readGncPrivateJson(resident+"/swanson.private.json") as any,runtime=await read(resident+"/channel-label-workflow.runtime.json"),id=browser.id+"-"+generation;
 assert.equal(base.r2.bucket,"supply-smart-test");assert.equal(new URL(base.database.connectionString).pathname,"/crawler_v3_test");
 const db=new pg.Pool({connectionString:base.database.connectionString,max:12}),r2=createR2Objects({...base.r2,prefix:base.r2.prefix+"/"+browser.id},base.r2Credentials);
 const report:any={id,status:"preparing",sourceProof:browser.id,scope:"two observed Healthy Origins K2 sizes",results:[],providerSettings:"unchanged resident configuration",deployment:"isolated queues; role factories in an acceptance harness"};
 const save=()=>writeFile(dir+"/report.json",JSON.stringify(report,null,2));await save();
 const baseline:Record<string,string[]>={};for(const t of ["collected_product","review_record","processing_result"])baseline[t]=(await db.query(`SELECT record_hash FROM ${t}`)).rows.map(r=>r.record_hash);
 await writeFile(dir+"/baseline.json",JSON.stringify(baseline));
 let connection:Connection|undefined,native:NativeConnection|undefined;
 const workers:Worker[]=[],runs:Promise<void>[]=[],modules:Awaited<ReturnType<typeof channelLabelRole>>[]=[];
 try{
  const t=runtime.transport;assert.equal(t.mode,"mtls");const tls={serverNameOverride:t.serverName,serverRootCACertificate:await readFile(t.caFile),clientCertPair:{crt:await readFile(t.certFile),key:await readFile(t.keyFile)}};
  connection=await Connection.connect({address:runtime.address,tls});native=await NativeConnection.connect({address:runtime.address,tls});const client=new Client({connection,namespace:runtime.namespace});
  const launch=async(options:Parameters<typeof Worker.create>[0])=>{const w=await Worker.create(options);workers.push(w);const run=w.run();run.catch(()=>{});runs.push(run);};
  const queues:Record<string,string>={},names:Record<string,string>={"page-text":"pageText","image-prepare":"imagePrepare","ocr-receipts":"ocrReceipts","text-receipts":"textReceipts"};
  for(const [role,activityNames]of Object.entries(channelLabelRoutes)){
   const c=await readGncPrivateJson(resident+"/label-"+role+".private.json") as any,rt=await read(resident+"/channel-label-"+role+".runtime.json");
   const module=await channelLabelRole({role,hostId:rt.hostId,root:join(dir,role),db,resourceDb:db,remote:r2.store,storageId:c.storageId,...(c.codex?{codex:c.codex}:{}),...(c.ocrProvider?{ocrProvider:c.ocrProvider}:{})});
   modules.push(module);await module.check();const queue=id+"-"+role;queues[names[role]??role]=queue;
   await launch({connection:native,namespace:runtime.namespace,taskQueue:queue,activities:Object.fromEntries(activityNames.map(name=>[name,(raw:unknown)=>runChannelLabelActivity(name,raw,module.stops,module.activities[name]!)])),shutdownGraceTime:"15 seconds"});
  }
  const {resources:resourceQueue,...labelQueues}=queues,bundle={codePath:root+"/swanson-coverage-tests-20260910-final/product-workflows.cjs"};
  await launch({connection:native,namespace:runtime.namespace,taskQueue:id,workflowBundle:bundle});
  const resources={...base.labelResources,queue:resourceQueue},inputs=browser.products.map((p:any)=>ChannelSavedLabelWorkflowInputSchema.parse({input:ChannelLabelInputSchema.parse({operationId:`coverage-${generation}-${p.plan.owner.variantId}-${browser.id}`,sourcePlan:p.plan,text:base.labelText,visionConfigFingerprint:base.visionConfigFingerprint,evidencePolicy:base.evidencePolicy,corePolicy:"swanson-label-core/1"}),queues:labelQueues,resources}));
  await writeFile(dir+"/inputs.json",JSON.stringify(inputs,null,2));report.status="running";await save();
  const result=await Promise.allSettled(inputs.map(async(input:any)=>{
   const workflowId=`${id}-${input.input.sourcePlan.owner.variantId}`,h=await client.workflow.start("ChannelSavedLabelWorkflow",{workflowId,taskQueue:id,args:[input],workflowExecutionTimeout:"20 minutes",retry:{maximumAttempts:1}});
   console.log(JSON.stringify({event:"COVERAGE_LABEL_STARTED",workflowId}));const outcome=await h.result(),history=await h.fetchHistory();
   await Worker.runReplayHistory({workflowBundle:bundle},history,workflowId);await writeFile(dir+"/"+workflowId+".history.json",JSON.stringify(history));
   const row={workflowId,runId:(await h.describe()).runId,owner:input.input.sourcePlan.owner,outcome,replay:true};report.results.push(row);await save();console.log(JSON.stringify({event:"COVERAGE_LABEL_RESULT",...row}));return row;
  }));
  report.failedWorkflows=result.filter(r=>r.status==="rejected").length;
  const records:any={};for(const table of Object.keys(baseline)){
   const rows=(await db.query(`SELECT record,record_hash FROM ${table}`)).rows,current=new Set(rows.map(r=>r.record_hash));assert.ok(baseline[table]!.every(h=>current.has(h)));
   records[table]=rows.filter(r=>!baseline[table]!.includes(r.record_hash)&&JSON.stringify(r.record).includes(browser.id));
  }
  await writeFile(dir+"/records.json",JSON.stringify(records,null,2));report.oldRecordsPreserved=true;report.counts=Object.fromEntries(Object.entries(records).map(([t,r])=>[t,(r as any[]).length]));
  const refs=new Map<string,any>();const walk=(o:any)=>{if(!o||typeof o!=="object")return;if(o.objectKey&&o.sha256&&o.byteSize)refs.set(o.objectKey,o);for(const v of Object.values(o))walk(v);};walk(records);walk(browser.products);
  report.artifacts=[];for(const r of refs.values()){const b=await r2.store.read(r.objectKey,30*1024*1024,AbortSignal.timeout(30000));assert.ok(b);assert.equal(b.length,r.byteSize);assert.equal(sha256(b),r.sha256);report.artifacts.push({objectKey:r.objectKey,sha256:r.sha256,verified:true});}
  report.held=(await db.query("SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL AND request->>'workflowId' LIKE $1",[id+"%"])).rows[0].n;
  report.status=report.failedWorkflows?"failed":report.results.every((r:any)=>r.outcome.status==="collected")&&records.collected_product.length===2?"passed":"review";
 }catch(e){report.status="failed";report.error=e instanceof Error?e.message:"UNKNOWN";process.exitCode=1;}
 finally{for(const w of workers)if(w.getState()==="RUNNING")w.shutdown();await Promise.allSettled(runs);await Promise.allSettled(modules.map(m=>m.close()));await native?.close();await connection?.close();r2.close();await db.end();report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({event:"COVERAGE_LABEL_FINISHED",dir,status:report.status,counts:report.counts,held:report.held,error:report.error}));}
}
main().catch(()=>{console.error("COVERAGE_LABEL_REJECTED");process.exitCode=1;});
