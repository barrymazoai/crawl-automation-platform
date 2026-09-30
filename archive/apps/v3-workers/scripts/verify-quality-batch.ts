/** Independent read-only source/quality audit; no provider or workflow execution. */
import assert from "node:assert/strict";
import {readFile,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {hostname} from "node:os";
import pg from "pg";
import {Client,Connection} from "@temporalio/client";
import {createR2Objects,verifyBytes} from "@crawl-automation/v3-artifacts";
import {ArtifactRefSchema,TextDocumentSchema,LabelCollectedProductSchema,LabelProductJoinSchema} from "@crawl-automation/v3-contracts";
import {PostgresLabelCollectedProducts} from "@crawl-automation/v3-product";
import {readGncPrivateJson} from "../src/gnc-config.js";
const [dir,privatePath,runtimePath]=process.argv.slice(2);assert.ok(dir&&privatePath&&runtimePath);assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
assert.match(dir,/^\/Users\/barry\/apps\/crawlv3-channel-restored\.PCrTm6\/quality-batch-2\/channel-label-[a-f0-9-]+$/);
const json=async(p:string)=>JSON.parse(await readFile(p,"utf8")),report=await json(join(dir,"report.json"));assert.ok(report.finishedAt);assert.ok(["passed","review"].includes(report.status));
const base=await readGncPrivateJson(privatePath) as any,runtime=await json(runtimePath),t=runtime.transport;
assert.equal(base.r2.bucket,"supply-smart-test");assert.equal(new URL(base.reviewDatabase.connectionString).pathname,"/crawler_v3_test");
const db=new pg.Pool({connectionString:base.reviewDatabase.connectionString,options:"-c default_transaction_read_only=on",statement_timeout:10000});
const r2=createR2Objects({...base.r2,prefix:`${base.r2.prefix}/${report.browserProofId}`},base.r2Credentials);
const connection=await Connection.connect({address:runtime.address,tls:{serverNameOverride:t.serverName,serverRootCACertificate:await readFile(t.caFile),clientCertPair:{crt:await readFile(t.certFile),key:await readFile(t.keyFile)}}});
const signal=()=>AbortSignal.timeout(30000),normalize=(s:string)=>s.toLowerCase().replace(/\s+/g,"").replace(/[.]$/,"");
try{
 const client=new Client({connection,namespace:runtime.namespace}),registry=new PostgresLabelCollectedProducts(db),products:any[]=[],workflows:any[]=[];
 const refs=new Map<string,ReturnType<typeof ArtifactRefSchema.parse>>();
 const visit=(v:any)=>{if(!v||typeof v!=="object")return;const parsed=ArtifactRefSchema.safeParse(v);if(parsed.success)refs.set(parsed.data.objectKey,parsed.data);Object.values(v).forEach(visit)};
 for(const row of report.results){const d=await client.workflow.getHandle(row.workflowId).describe();assert.equal(d.status.name,"COMPLETED");workflows.push({workflowId:row.workflowId,status:d.status.name});}
 for(const row of report.results.filter((r:any)=>r.workflowId.endsWith("-first"))){
  const bytes=await r2.store.read(row.result.evidenceKey,8388608,signal());assert.ok(bytes);const assembly=JSON.parse(Buffer.from(bytes).toString());const input=LabelProductJoinSchema.parse(assembly.input);assert.equal(input.manifest.operationId,row.operationId);visit(assembly);
  const record=await registry.read(row.operationId),sourceReviews=[];
  for(const state of input.states.filter(s=>s.status==="review")){if(state.status!=="review")continue;const r=(await db.query("SELECT record FROM review_record WHERE review_id=$1",[state.reviewId])).rows[0]?.record;assert.ok(r);sourceReviews.push({id:state.id,code:r.failure.code,candidate:r.candidate});}
  const checks:any={listingId:row.listingId,status:row.result.status,sourceReviews,assemblyStatus:assembly.result.status,assemblyIngredients:assembly.result.otherIngredients?.items,assemblySources:assembly.result.provenance?.map((p:any)=>({id:p.id,kind:p.kind,candidate:p.candidate})),assemblyWarnings:assembly.result.warnings};
  if(row.listingId==="8572156018826")checks.wrappedIngredientCorrect=assembly.result.status==="ready"&&assembly.result.otherIngredients.items.length===3&&/gelatin\s*\(capsule\)/i.test(assembly.result.otherIngredients.items[0].text);
  if(record){visit(record);assert.equal(record.evidencePolicy,"label-image-first/3");
   const expected=["BSE-free gelatin (capsule)","vegetable glycerine","double-distilled and deionized water"].map(normalize);
   const actual=record.otherIngredients!.items.map(i=>normalize(i.text));
   checks.otherIngredients=record.otherIngredients!.items.map(i=>i.text);checks.otherIngredientsMatch=JSON.stringify(actual)===JSON.stringify(expected);
   checks.formula=record.formula;checks.warnings=record.warnings;checks.formulaRows=record.formula.columns.flatMap(c=>c.rows).length;
   checks.sources=record.provenance.map(p=>({id:p.id,kind:p.kind,candidate:p.candidate}));
   checks.formulaTotalsMatch=row.listingId==="8572156018826"?
    record.formula.columns.flatMap(c=>c.rows).some(r=>r.kind==="blend_total"&&normalize(r.amount?.text??"")==="125mg"):
    ["268mg","432mg"].every(amount=>record.formula.columns.flatMap(c=>c.rows).some(r=>normalize(r.amount?.text??"")===amount));
   for(const source of record.provenance.filter(p=>p.kind==="text")){if(source.kind!=="text"||source.record.input.source.kind!=="prepared")throw Error();const ref=source.record.input.source.document,b=await r2.store.read(ref.objectKey,ref.byteSize,signal());assert.ok(b);verifyBytes(ref,b,ref.byteSize);const doc=TextDocumentSchema.parse(JSON.parse(Buffer.from(b).toString()));assert.equal(doc.corePolicy,"swanson-label-core/1");assert.doesNotMatch(doc.text,/Suggested Use|Storage Instructions/);visit(doc);}
   await writeFile(join(dir,`${row.listingId}-audited-product.json`),JSON.stringify(LabelCollectedProductSchema.parse(record),null,2),{mode:0o600});
  }
  products.push(checks);
 }
 for(const ref of refs.values()){const b=await r2.store.read(ref.objectKey,ref.byteSize,signal());assert.ok(b);verifyBytes(ref,b,ref.byteSize);}
 const counts=(await db.query("SELECT (SELECT count(*)::int FROM collected_product) collected,(SELECT count(*)::int FROM review_record) reviews,(SELECT count(*)::int FROM resource_permit WHERE released_at IS NULL) held")).rows[0];assert.equal(counts.held,0);
 const health=await json("/Users/barry/apps/crawlv3-batch-a.UiA4dx/status.json");assert.ok(Date.now()-Date.parse(health.at)<30000);assert.ok(health.jobs.every((j:any)=>j.ready));
 const result={at:new Date().toISOString(),id:report.id,workflows,products,artifactCount:refs.size,counts,readyResidentWorkers:health.jobs.length,providerCalls:report.providerCalls,coldProviderCalls:report.coldProviderCalls,databaseWrites:0,r2Writes:0};
 await writeFile(join(dir,"verification.json"),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));
}finally{await db.end();r2.close();await connection.close();}
