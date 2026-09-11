import assert from "node:assert/strict";
import {hostname} from "node:os";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {isDeepStrictEqual} from "node:util";
import pg from "pg";
import {Client,Connection} from "@temporalio/client";
import {Worker,NativeConnection} from "@temporalio/worker";
import {createR2Objects,RetainedPublication,sha256} from "@crawl-automation/v3-artifacts";
import {ChannelLabelManifestResultSchema,ChannelLabelSourceResultSchema,LabelProductJoinSchema} from "@crawl-automation/v3-contracts";
import {TextLocalStore} from "@crawl-automation/v3-text";
import {channelLabelRole} from "../src/channel-label-role.js";
import {runChannelLabelActivity} from "../src/channel-label-execution.js";

// New, bounded assembly-only recovery. No browser, OCR or model worker is constructed.
async function main(){
 assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);assert.equal(process.argv[2],"--verified-sources-only");
 const root="/Users/barry/apps/crawlv3-batch-a.UiA4dx",id="swanson-coverage-2df9dfc1-33de-413b-93fa-4531a4428311",source=root+"/live/"+id+"/label-20260911",dir=source+"/collection-recovery",resident=root+"/live/channel-resident-20260910-v2",read=async(p:string)=>JSON.parse(await readFile(p,"utf8"));
 await mkdir(dir,{mode:0o700});const base=await read(resident+"/swanson.private.json"),runtime=await read(resident+"/channel-label-workflow.runtime.json");
 assert.equal(new URL(base.database.connectionString).pathname,"/crawler_v3_test");assert.equal(base.r2.bucket,"supply-smart-test");
 const db=new pg.Pool({connectionString:base.database.connectionString,max:4}),r2=createR2Objects({...base.r2,prefix:base.r2.prefix+"/"+id},base.r2Credentials),report:any={status:"preparing",modelCalls:0,ocrCalls:0,browserCalls:0,oldManifestReuploaded:false};
 const workers:Worker[]=[],runs:Promise<void>[]=[],modules:Awaited<ReturnType<typeof channelLabelRole>>[]=[];let connection:Connection|undefined,native:NativeConnection|undefined;
 try{
  const prior=await read(source+"/report.json"),old=prior.results.find((r:any)=>r.owner.variantId==="46318811709578");assert.equal(old.outcome.code,"CHANNEL.LABEL_PREPARATION_UNVERIFIED");assert.equal(prior.held,0);
  const key=`v3/channel-labels/${old.outcome.operationId}/manifest.json`,raw=await read(source+"/manifest/journal/"+key),manifest=ChannelLabelManifestResultSchema.parse(raw);
  const expected=(await read(source+"/inputs.json")).find((i:any)=>i.input.sourcePlan.owner.variantId==="46318811709578").input;assert.deepEqual(manifest.input,expected);
  assert.equal(await r2.store.read(key,1024*1024,AbortSignal.timeout(30000)),null,"Original unknown upload changed; inspect before recovery");
  const review=(await db.query("SELECT record FROM review_record WHERE review_id=$1",[old.outcome.reviewId])).rows[0]?.record;assert.ok(review);assert.deepEqual(review.rawError.details.input,expected);
  const states=review.rawError.details.states;assert.ok(states.every((s:any)=>["registered","not_matched"].includes(s.status)));
  const sources=[];for(const state of states){const sourceKey=`v3/channel-labels/${expected.operationId}/sources/${state.id}.json`,b=await r2.store.read(sourceKey,1024*1024,AbortSignal.timeout(30000));assert.ok(b);const s=ChannelLabelSourceResultSchema.parse(JSON.parse(Buffer.from(b).toString()));assert.deepEqual(s.input,{input:expected,sourceId:state.id});
   if(state.status==="registered"){assert.equal(s.status,"prepared");assert.ok(s.status==="prepared");sources.push(s.source);}else{assert.equal(s.status,"not_matched");assert.ok(manifest.skipped.includes(state.id));}
  }
  assert.ok(isDeepStrictEqual(manifest.manifest.sources,sources));
  const operationId="coverage-collect-20260911-46318811709578-"+id,join=LabelProductJoinSchema.parse({manifest:{...manifest.manifest,operationId},states:states.filter((s:any)=>s.status==="registered")});
  const local=await TextLocalStore.open(dir+"/journal"),recovery={codec:"verified-label-collection-recovery/1",priorWorkflowId:old.workflowId,priorReviewId:old.outcome.reviewId,priorManifestKey:key,priorLocalManifestSha256:sha256(Buffer.from(JSON.stringify(raw))),join};
  await new RetainedPublication(local,r2.store).publish("v3/collection-recoveries/"+operationId+".json",Buffer.from(JSON.stringify(recovery)),"application/json",AbortSignal.timeout(30000));
  await writeFile(dir+"/input.json",JSON.stringify(recovery,null,2));const baseline:any={};for(const table of ["collected_product","review_record","processing_result"])baseline[table]=(await db.query(`SELECT record_hash FROM ${table}`)).rows.map(r=>r.record_hash);await writeFile(dir+"/baseline.json",JSON.stringify(baseline));
  const t=runtime.transport,tls={serverNameOverride:t.serverName,serverRootCACertificate:await readFile(t.caFile),clientCertPair:{crt:await readFile(t.certFile),key:await readFile(t.keyFile)}};connection=await Connection.connect({address:runtime.address,tls});native=await NativeConnection.connect({address:runtime.address,tls});
  const client=new Client({connection,namespace:runtime.namespace});assert.equal((await client.workflow.getHandle(old.workflowId).describe()).status.name,"COMPLETED");
  const launch=async(o:Parameters<typeof Worker.create>[0])=>{const w=await Worker.create(o);workers.push(w);const run=w.run();run.catch(()=>{});runs.push(run);};const queues:any={};
  for(const role of ["assembly","collection"]){const c=await read(resident+"/label-"+role+".private.json"),rt=await read(resident+"/channel-label-"+role+".runtime.json"),m=await channelLabelRole({role,hostId:rt.hostId,root:dir+"/"+role,db,remote:r2.store,storageId:c.storageId});modules.push(m);await m.check();const name=role==="assembly"?"assembleLabelProduct":"collectLabelProduct";queues[role]=operationId+"-"+role;await launch({connection:native,namespace:runtime.namespace,taskQueue:queues[role],activities:{[name]:(raw:unknown)=>runChannelLabelActivity(name,raw,m.stops,m.activities[name]!)}});}
  const bundle={codePath:root+"/swanson-coverage-tests-20260910-final-v2/product-workflows.cjs"};await launch({connection:native,namespace:runtime.namespace,taskQueue:operationId,workflowBundle:bundle});
  const h=await client.workflow.start("finishLabelProduct",{workflowId:operationId,taskQueue:operationId,args:[join,queues],retry:{maximumAttempts:1},workflowExecutionTimeout:"5 minutes"});report.workflowId=operationId;report.status="running";await writeFile(dir+"/report.json",JSON.stringify(report,null,2));report.outcome=await h.result();
  const history=await h.fetchHistory();await Worker.runReplayHistory({workflowBundle:bundle},history,operationId);await writeFile(dir+"/history.json",JSON.stringify(history));report.replay=true;
  const records:any={};for(const table of Object.keys(baseline)){const rows=(await db.query(`SELECT record_hash,record FROM ${table}`)).rows,hashes=new Set(rows.map(r=>r.record_hash));assert.ok(baseline[table].every((h:string)=>hashes.has(h)));records[table]=rows.filter(r=>!baseline[table].includes(r.record_hash));}await writeFile(dir+"/records.json",JSON.stringify(records,null,2));report.counts=Object.fromEntries(Object.entries(records).map(([k,v])=>[k,(v as any[]).length]));report.oldRecordsPreserved=true;
  const refs=new Map<string,any>();const walk=(v:any)=>{if(!v||typeof v!=="object")return;if(v.objectKey&&v.sha256&&v.byteSize)refs.set(v.objectKey,v);Object.values(v).forEach(walk);};walk(records);report.artifacts=[];for(const ref of refs.values()){const b=await r2.store.read(ref.objectKey,30*1024*1024,AbortSignal.timeout(30000));assert.ok(b);assert.equal(b.length,ref.byteSize);assert.equal(sha256(b),ref.sha256);report.artifacts.push({objectKey:ref.objectKey,sha256:ref.sha256,verified:true});}
  report.held=(await db.query("SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL")).rows[0].n;report.status=report.outcome.status==="collected"&&records.collected_product.length===1?"passed":"review";
 }catch(e){report.status="failed";report.error=e instanceof Error?e.message:"UNKNOWN";process.exitCode=1;}
 finally{for(const w of workers)if(w.getState()==="RUNNING")w.shutdown();await Promise.allSettled(runs);await Promise.allSettled(modules.map(m=>m.close()));await native?.close();await connection?.close();r2.close();await db.end();report.finishedAt=new Date().toISOString();await writeFile(dir+"/report.json",JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
}
main().catch(()=>{console.error("RECOVERY_REJECTED");process.exitCode=1;});
