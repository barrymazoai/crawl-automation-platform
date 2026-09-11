/** Independent read-only audit. No provider, workflow start, database write or artifact publication. */
import assert from "node:assert/strict";
import {readFile,readdir,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {hostname} from "node:os";
import pg from "pg";
import {Client,Connection} from "@temporalio/client";
import {ArtifactRefSchema} from "@crawl-automation/v3-contracts";
import {createR2Objects,verifyBytes,sha256} from "@crawl-automation/v3-artifacts";
import {decodeLabelImageV2} from "@crawl-automation/v3-vision";
import {readGncPrivateJson} from "../src/gnc-config.js";
async function main(){
 assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);const[dir,privatePath,originalPath,runtimePath]=process.argv.slice(2);assert.ok(dir&&privatePath&&originalPath&&runtimePath);assert.match(dir,/^\/Users\/barry\/apps\/crawlv3-channel-restored\.PCrTm6\/quality-batch-3\/visual-quality-[a-f0-9-]+$/);
 const json=async(p:string)=>JSON.parse(await readFile(p,"utf8")),report=await json(join(dir,"report.json"));assert.equal(report.status,"passed");assert.ok(report.finishedAt);
 const base=await readGncPrivateJson(privatePath) as any,original=await readGncPrivateJson(originalPath) as any,runtime=await json(runtimePath),t=runtime.transport;
 assert.equal(new URL(base.reviewDatabase.connectionString).pathname,"/crawler_v3_test");assert.equal(new URL(original.reviewDatabase.connectionString).port,"32806");
 const db=new pg.Pool({connectionString:base.reviewDatabase.connectionString,options:"-c default_transaction_read_only=on"}),old=new pg.Pool({connectionString:original.reviewDatabase.connectionString,options:"-c default_transaction_read_only=on"});
 const r2=createR2Objects({...base.r2,prefix:`${base.r2.prefix}/${report.browserProofId}`},base.r2Credentials),connection=await Connection.connect({address:runtime.address,tls:{serverNameOverride:t.serverName,serverRootCACertificate:await readFile(t.caFile),clientCertPair:{crt:await readFile(t.certFile),key:await readFile(t.keyFile)}}});
 try{
  const client=new Client({connection,namespace:runtime.namespace}),workflows=[];
  for(const name of (await readdir(dir)).filter(n=>n.endsWith("-history.json"))){const id=`${report.id}-${name.slice(0,-"-history.json".length)}`,d=await client.workflow.getHandle(id).describe();assert.equal(d.status.name,"COMPLETED");workflows.push(id);}
  const refs=new Map<string,ReturnType<typeof ArtifactRefSchema.parse>>(),outputs:any[]=[];
  const visit=(v:any)=>{if(!v||typeof v!=="object")return;const p=ArtifactRefSchema.safeParse(v);if(p.success){const old=refs.get(p.data.objectKey);if(old)assert.deepEqual(old,p.data);refs.set(p.data.objectKey,p.data);}Object.values(v).forEach(visit)};
  for(const row of report.results)for(const kind of ["control","candidate"]){const output=await json(join(dir,`${row.listingId}-${kind}.json`)),key=`v3/label-products/${output.input.manifest.operationId}/assembly.json`,bytes=await r2.store.read(key,8388608,AbortSignal.timeout(30000));assert.ok(bytes);assert.deepEqual(JSON.parse(Buffer.from(bytes).toString()),output);visit(output);outputs.push({listingId:row.listingId,kind,status:output.result.status,codes:output.result.codes,warnings:output.result.warnings,formula:output.result.formula,ingredients:output.result.otherIngredients?.items.map((i:any)=>i.text)});}
  for(const ref of refs.values()){const bytes=await r2.store.read(ref.objectKey,ref.byteSize,AbortSignal.timeout(30000));assert.ok(bytes);verifyBytes(ref,bytes,ref.byteSize);}
  const old60=await json("/Users/barry/apps/crawlv3-channel-restored.PCrTm6/quality-batch-3/visual-quality-ade3b034-e790-4a2a-a983-e8878e712f08/first/journal/v3/vision/visual-quality-ade3b034-e790-4a2a-a983-e8878e712f08-8572156018826-vision/response.json");assert.equal(sha256(Buffer.from(old60.raw)),old60.sha256);const decoded=decodeLabelImageV2(old60.raw),c=decoded.candidate;
  const normalize=(s:string)=>s.toLowerCase().replace(/\s+/g," ").trim().replace(/[.]$/,"");
  assert.deepEqual(c.otherIngredients!.items.map(i=>normalize(i.text)),["bse-free gelatin (capsule)","vegetable glycerine","double-distilled and deionized water"]);
  assert.deepEqual(c.formula!.columns[0]!.rows.map(r=>r.amount?.text.replace(/\s/g,"")),["125mg","90%","10%"]);
  const products=(await db.query("SELECT operation_id,observation_id,record_hash FROM collected_product ORDER BY operation_id")).rows;assert.deepEqual(products,report.productsBefore);
  const oldProducts=(await old.query("SELECT operation_id,observation_id,record_hash FROM collected_product ORDER BY operation_id")).rows;assert.deepEqual(oldProducts,products);
  const oldCounts=(await old.query("SELECT (SELECT count(*)::int FROM collected_product) collected,(SELECT count(*)::int FROM review_record) reviews,(SELECT count(*)::int FROM resource_permit WHERE released_at IS NULL) held")).rows[0];assert.equal(oldCounts.held,0);
  const health=await json("/Users/barry/apps/crawlv3-batch-a.UiA4dx/status.json");assert.ok(Date.now()-Date.parse(health.at)<30000);assert.equal(health.jobs.length,32);assert.ok(health.jobs.every((j:any)=>j.ready));
  const result={at:new Date().toISOString(),status:"passed",id:report.id,workflows,artifactCount:refs.size,outputs,originalCounts:oldCounts,cloneCounts:report.counts,unchangedProducts:products.length,readyResidentWorkers:health.jobs.length,first60:{status:decoded.status,ingredientsAndProportionsMatch:true,heading:c.formula!.columns[0]!.heading?.text,registration:"preserved-handoff-review"},providerCalls:report.providerCalls,coldProviderCalls:report.coldProviderCalls,databaseWrites:0,r2Writes:0};await writeFile(join(dir,"verification.json"),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify({status:result.status,workflowCount:workflows.length,artifactCount:refs.size,originalCounts:oldCounts,cloneCounts:report.counts,readyResidentWorkers:health.jobs.length}));
 }finally{await db.end();await old.end();await connection.close();r2.close();}
}
main().catch(()=>{console.error("VISUAL_QUALITY_AUDIT_FAILED");process.exitCode=1});
