/** Read-only live audit; writes only local evidence in this isolated proof directory. */
import assert from "node:assert/strict";
import {readFile,writeFile} from "node:fs/promises";
import {hostname} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import pg from "pg";
import {S3Client,GetObjectCommand} from "@aws-sdk/client-s3";
import {Client,Connection} from "@temporalio/client";
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const[dir,privatePath,runtimePath]=process.argv.slice(2);
assert.match(dir??"",/^\/Users\/barry\/apps\/crawlv3-channel-restored\.PCrTm6\/source-quality-v1\/source-quality-[a-f0-9-]+$/);
const read=async p=>JSON.parse(await readFile(p,"utf8")),report=await read(join(dir,"report.json"));assert.equal(report.status,"passed");
const base=await read(privatePath),runtime=await read(runtimePath),t=runtime.transport;
assert.equal(base.r2.bucket,"supply-smart-test");assert.equal(new URL(base.reviewDatabase.connectionString).pathname,"/crawler_v3_test");
const db=new pg.Pool({connectionString:base.reviewDatabase.connectionString,options:"-c default_transaction_read_only=on",statement_timeout:10000});
const s3=new S3Client({region:"auto",endpoint:base.r2.endpoint,credentials:base.r2Credentials});
const connection=await Connection.connect({address:runtime.address,tls:{serverNameOverride:t.serverName,serverRootCACertificate:await readFile(t.caFile),clientCertPair:{crt:await readFile(t.certFile),key:await readFile(t.keyFile)}}});
const hash=b=>createHash("sha256").update(b).digest("hex"),prefix=`${base.r2.prefix}/${report.browserProofId}`;
const get=async key=>Buffer.from(await(await s3.send(new GetObjectCommand({Bucket:base.r2.bucket,Key:`${prefix}/${key}`}))).Body.transformToByteArray());
const refs=new Map(),verified=new Map();
function visit(v){if(!v||typeof v!=="object")return;if(v.objectKey&&v.sha256&&v.byteSize!==undefined&&v.producer)refs.set(v.objectKey,v);Object.values(v).forEach(visit);}
async function verify(ref){if(verified.has(ref.objectKey))return verified.get(ref.objectKey);const b=await get(ref.objectKey);assert.equal(b.length,ref.byteSize);assert.equal(hash(b),ref.sha256);verified.set(ref.objectKey,b);return b;}
try{
 const client=new Client({connection,namespace:runtime.namespace}),workflows=[];
 for(const item of [...report.cores,...report.results,...report.results.map(r=>r.cold)]){const d=await client.workflow.getHandle(item.workflowId).describe();assert.equal(d.status.name,"COMPLETED");workflows.push({workflowId:item.workflowId,status:d.status.name,runId:d.runId});}
 const products=[];
 for(const result of report.results){
  const input=await read(join(dir,`${result.listingId}-input.json`)),op=input.manifest.operationId;
  const assembly=JSON.parse((await get(result.result.evidenceKey)).toString());assert.equal(assembly.input.manifest.operationId,op);visit(assembly);
  const rows=(await db.query("SELECT record FROM collected_product WHERE operation_id=$1",[op])).rows;
  const reviews=(await db.query("SELECT record FROM review_record WHERE record->'failure'->>'operationId'=$1",[op])).rows;
  assert.equal(rows.length,result.registered?1:0);assert.equal(reviews.length,result.registered?0:1);
  for(const state of input.states.filter(s=>s.status==="review")){const original=(await db.query("SELECT record FROM review_record WHERE review_id=$1",[state.reviewId])).rows[0];assert.ok(original);await writeFile(join(dir,`${result.listingId}-${state.id}-original-review.json`),JSON.stringify(original.record,null,2),{mode:0o600});}
  if(rows.length){const product=rows[0].record;assert.equal(product.evidencePolicy,"label-image-first/2");assert.ok(product.warnings.some(w=>w.code==="TEXT.LABEL_GROUP_EMPTY"));visit(product);products.push({listingId:result.listingId,rows:product.formula.columns.flatMap(c=>c.rows),otherIngredients:product.otherIngredients.items,warnings:product.warnings});}
  for(const source of input.manifest.sources.filter(s=>s.kind==="image")){const ref=source.task.input.selection.image,b=await verify(ref);await writeFile(join(dir,`${result.listingId}-label-original.${ref.mediaType==="image/png"?"png":"jpg"}`),b,{mode:0o600});}
 }
 const cores=[];for(const c of report.cores){visit(c.result);const doc=JSON.parse((await verify(c.result.document)).toString());visit(doc);assert.equal(doc.corePolicy,"swanson-label-core/1");assert.doesNotMatch(doc.text,/Suggested Use|Warning:|Storage Instructions/);cores.push({listingId:doc.listingId,text:doc.text});}
 for(const ref of refs.values())await verify(ref);
 const counts=(await db.query("SELECT (SELECT count(*)::int FROM collected_product) collected,(SELECT count(*)::int FROM review_record) reviews,(SELECT count(*)::int FROM resource_permit WHERE released_at IS NULL) held")).rows[0];assert.equal(counts.held,0);
 const health=await read("/Users/barry/apps/crawlv3-batch-a.UiA4dx/status.json");assert.ok(Date.now()-Date.parse(health.at)<30000);assert.ok(health.jobs.every(j=>j.ready));
 const getDashboard=async path=>{const r=await fetch(`http://127.0.0.1:4188/api/v3/${path}`,{headers:{"x-v3-client":"local-workspace"},signal:AbortSignal.timeout(10000)});assert.equal(r.status,200);return r.json();};
 const dashboard=await getDashboard("dashboard");
 assert.equal(dashboard.collectedProducts,counts.collected);assert.equal(dashboard.reviews,counts.reviews);
 const listing=await getDashboard("dashboard/products");
 assert.ok(listing.items.some(p=>p.observation.listingId==="8572156018826"&&p.formulaRows===3));
 const audit={at:new Date().toISOString(),proofId:report.id,workflows,retainedArtifactsVerified:verified.size,products,cores,cumulativeCounts:counts,dashboard,readyResidentWorkers:health.jobs.length,providerCalls:report.providerCalls,browserCalls:0,databaseWrites:0,r2Writes:0};
 await writeFile(join(dir,"verification.json"),JSON.stringify(audit,null,2),{mode:0o600});console.log(JSON.stringify(audit));
}finally{await db.end();s3.destroy();await connection.close();}
