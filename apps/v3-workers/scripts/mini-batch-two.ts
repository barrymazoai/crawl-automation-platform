// Bounded acceptance: synthetic directory faults + real archived product, in separate databases.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { msToTs } from "@temporalio/common/lib/time.js";
import { CatalogPageSchema, OcrRegistrationSchema, TextRecordSchema, VisionRecordSchema, DashboardSummarySchema, DashboardProductsSchema, DashboardReviewsSchema } from "@crawl-automation/v3-contracts";
import { catalogPage, catalogScope } from "../../../packages/v3-contracts/src/catalog.fixture.js";
import { PostgresCatalog } from "../../../packages/v3-product/src/catalog-ledger.js";
import { PostgresCatalogProducts, buildGncCatalogProduct } from "../../../packages/v3-product/src/catalog-product.js";
import { catalogProductPolicy } from "../../../packages/v3-product/src/catalog-product.fixture.js";
import { PostgresDashboard } from "../../v3-api/src/storage/postgres-dashboard.js";
import { PostgresBrands } from "../../v3-api/src/storage/postgres-brands.js";
import { migrate, migrationNames } from "../../v3-api/src/bootstrap/schema.js";
import { createApp } from "../../v3-api/src/http/app.js";
import { PostgresReviews } from "@crawl-automation/v3-review";
import { fixture as reviewFixture } from "../../../packages/v3-review/src/testing.fixture.js";
import { PostgresResultRegistry } from "@crawl-automation/v3-results";
import { PostgresTextRegistry } from "@crawl-automation/v3-text";
import { PostgresVisionRegistry } from "@crawl-automation/v3-vision";
import { PostgresLabelCollectedProducts } from "../../../packages/v3-product/src/label-product.js";
const [flag, root] = process.argv.slice(2);
assert.equal(flag, "--isolated-acceptance"); assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
assert.match(root!, /^\/Users\/barry\/apps\/crawlv3-batch-two\.[A-Za-z0-9]+\/live$/);
const dist = dirname(fileURLToPath(import.meta.url)), exec = promisify(execFile), id = randomUUID(), container = `crawlv3-batch2-${id.slice(0,8)}`;
const namespace = `batch2-${id}`, reports: {name:string;passed:boolean}[] = [];
const privateJson = (name: string, value: unknown) => writeFile(join(root!,name),JSON.stringify(value,null,2),{mode:0o600,flag:"wx"});
const check = async (name:string, fn:()=>Promise<void>) => { await fn(); reports.push({name,passed:true}); console.log(JSON.stringify({check:name,passed:true})); };
async function until(fn:()=>Promise<boolean>, ms=30000) { const end=Date.now()+ms; while(!await fn()){if(Date.now()>end)throw Error("WAIT_TIMEOUT");await new Promise(r=>setTimeout(r,200));} }
let db:pg.Pool|undefined, uiDb:pg.Pool|undefined, connection:Connection|undefined, native:NativeConnection|undefined;
let owned=false, success=false;
const workers:Worker[]=[], runs:Promise<void>[]=[];
const handles: {workflowId:string; result:()=>Promise<unknown>; signal:(s:string)=>Promise<void>}[]=[];
try {
  await mkdir(root!,{mode:0o700}); await privateJson("intent.json",{id,container,namespace,fixtureCatalog:true,liveProviderCalls:0});
  const password=randomUUID(); await writeFile(join(root!,"postgres.env"),`POSTGRES_USER=v3_admin\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=crawler_v3_test\n`,{mode:0o600,flag:"wx"});
  await mkdir(join(root!,"postgres-data"),{mode:0o700});
  await exec("docker",["run","-d","--name",container,"--label",`crawlv3.batch2=${id}`,"--publish","127.0.0.1::5432","--env-file",join(root!,"postgres.env"),"--mount",`type=bind,src=${join(root!,"postgres-data")},dst=/var/lib/postgresql`,"postgres:18"],{timeout:30000});owned=true;
  const port=Number((await exec("docker",["port",container,"5432/tcp"])).stdout.trim().split(":").at(-1)); assert.ok(port>0);
  const connect=(database:string)=>new pg.Pool({host:"127.0.0.1",port,user:"v3_admin",password,database,max:6,connectionTimeoutMillis:2000,statement_timeout:10000}); db=connect("crawler_v3_test");
  await until(async()=>{try{await db!.query("SELECT 1");return true;}catch{return false;}});
  const migrations=await Promise.all(migrationNames.map(async name=>{const sql=await readFile(join(dist,"migrations",name),"utf8");return{name,sql,sha256:createHash("sha256").update(sql).digest("hex")};}));
  const migrateOne=async(pool:pg.Pool)=>{const c=await pool.connect();try{await migrate(c,migrations);}finally{c.release();}};
  await check("all migrations on new isolated database",async()=>{await migrateOne(db!); assert.equal((await db!.query("SELECT count(*)::int AS n FROM v3_local_migration")).rows[0].n,migrationNames.length);});
  const ledger = new PostgresCatalog(db,async p=>{assert.ok(p.source.objectKey.startsWith("synthetic/"));});
  const dispatch=async(d:any)=>ledger.dispatch({discovery:d,workflowId:d.workflowId,runId:randomUUID()});
  await check("catalog product factory verifies ledger, concurrent intent, immutable configuration and ownership",async()=>{
    const products = new PostgresCatalogProducts(db!);
    const committed = await ledger.commit(catalogPage("factory",0,"unknown",["613701","222222"]));
    const [a,b] = committed.discoveries; assert.ok(a && b);
    const policy = catalogProductPolicy("factory");
    const execution = {clusterId:"test",namespace,workflowId:a.workflowId,runId:randomUUID()};
    let calls=0; const resolve=(d:unknown)=>{calls++;return buildGncCatalogProduct(d,policy);};
    const [one,two]=await Promise.all([products.prepare(a,execution,resolve),products.prepare(a,execution,resolve)]);assert.deepEqual(one,two);
    assert.equal((await db!.query("SELECT count(*)::int AS n FROM catalog_product_input")).rows[0].n,1);
    assert.equal((await db!.query("SELECT count(*)::int AS n FROM observation_execution")).rows[0].n,1);
    await assert.rejects(products.prepare(a,{...execution,workflowId:"wrong"},resolve),/WORKFLOW_IDENTITY/);
    const before=calls;await assert.rejects(products.prepare({...a,entry:{...a.entry,url:"https://www.gnc.com/changed/613701.html"}},execution,resolve),/DISCOVERY_UNVERIFIED/);assert.equal(calls,before);
    const changed={...policy,queue:"changed-queue"};await assert.rejects(products.prepare(a,execution,d=>buildGncCatalogProduct(d,changed)),/PRODUCT_INPUT_CONFLICT/);
    await assert.rejects(products.prepare(b,{...execution,workflowId:b.workflowId},()=>one),/PRODUCT_IDENTITY/);
    const other=await products.prepare(b,{...execution,workflowId:b.workflowId},resolve);
    assert.notEqual(one.input.input.sourcePlan.task.owner.observationId,other.input.input.sourcePlan.task.owner.observationId);
    await assert.rejects(db!.query("UPDATE catalog_product_input SET record='{}'"),/immutable/);
    assert.equal((await db!.query("SELECT count(*)::int AS n FROM catalog_product_input")).rows[0].n,2);
  });
  const presence=(catalogId:string,listingId:string,scope=catalogScope,variantId:string|null=null,operationId=`presence-${randomUUID()}`)=>ledger.presence({operationId,catalogId,scope,listingId,variantId});
  await check("duplicate cards and concurrent page receipts are idempotent",async()=>{
    const p=catalogPage("dedup",0,"more",["613701","613701"]); const [a,b]=await Promise.all([ledger.commit(p),ledger.commit(p)]); assert.deepEqual(a,b);assert.equal(a.discoveries.length,1);
    await dispatch(a.discoveries[0]); const c=await ledger.commit(catalogPage("dedup",1,"complete",["613701","222222"]));assert.equal(c.discoveries.length,1);await dispatch(c.discoveries[0]);assert.deepEqual(await ledger.close({catalogId:"dedup",scope:catalogScope,failure:null}),{status:"complete"});
  });
  await check("presence uses discovery even when no product processed, variant and scope exact",async()=>{
    assert.equal((await presence("dedup","613701")).status,"exists");assert.equal((await presence("dedup","missing")).status,"confirmed_absent");
    assert.equal((await presence("dedup","613701",{...catalogScope,region:"CA"})).status,"unknown");
    assert.equal((await presence("dedup","613701",catalogScope,"other-variant")).status,"confirmed_absent");
    assert.equal((await db!.query("SELECT count(*)::int AS n FROM collected_product")).rows[0].n,0);
  });
  await check("incomplete directory never implies absence; known products still exist",async()=>{
    await ledger.commit(catalogPage("partial",0,"unknown"));await ledger.close({catalogId:"partial",scope:catalogScope,failure:null});
    assert.equal((await presence("partial","missing")).status,"unknown");assert.equal((await presence("partial","613701")).status,"exists");
  });
  await check("concurrent presence replay stable; same operation cannot change target",async()=>{
    const op=`presence-${randomUUID()}`;const [a,b]=await Promise.all([presence("partial","missing",catalogScope,null,op),presence("partial","missing",catalogScope,null,op)]);assert.deepEqual(a,b);
    await assert.rejects(presence("partial","613701",catalogScope,null,op),/INPUT_CONFLICT/);
  });
  await check("gaps, changed pages, scope conflicts and unverified evidence rejected",async()=>{
    await assert.rejects(ledger.commit(catalogPage("gap",2)),/PAGE_GAP/);
    await assert.rejects(ledger.commit(catalogPage("partial",0,"unknown",["different"])),/PAGE_CONFLICT/);
    const p=catalogPage("partial");p.input.scope.region="CA";await assert.rejects(ledger.commit(p),/SCOPE_CONFLICT/);
    const invalid=new PostgresCatalog(db!,async()=>{throw Error("UNVERIFIED");});await assert.rejects(invalid.commit(catalogPage("unverified")),/UNVERIFIED/);
    assert.equal((await db!.query("SELECT 1 FROM catalog_run WHERE catalog_id='unverified'")).rowCount,0);
  });
  await check("cursor loops, unknown dispatch and immutable evidence",async()=>{
    await ledger.commit(catalogPage("loop",0,"more"));await ledger.commit(catalogPage("loop",1,"more"));const p=catalogPage("loop",2,"more");p.nextCursor=catalogPage("loop",1).input.cursor;
    await assert.rejects(ledger.commit(p),/CURSOR_LOOP/);
    const pending=await ledger.commit(catalogPage("pending"));assert.equal((await ledger.close({catalogId:"pending",scope:catalogScope,failure:null})).status,"incomplete");
    await dispatch(pending.discoveries[0]);assert.equal((await presence("pending","missing")).status,"unknown");
    await assert.rejects(db!.query("UPDATE catalog_closure SET status='complete' WHERE catalog_id='pending'"),/immutable/);
  });
  const parent="/Users/barry/apps/crawlv3-gnc-e2e.FzqLa3", deployment=JSON.parse(await readFile(join(parent,"deployment.json"),"utf8"));
  const tls={serverNameOverride:deployment.tlsServerName,serverRootCACertificate:await readFile(join(parent,"ca.pem")),clientCertPair:{crt:await readFile(join(parent,"mac-worker.pem")),key:await readFile(join(parent,"mac-worker-key.pem"))}};
  connection=await Connection.connect({address:deployment.address,tls,connectTimeout:"15 seconds"});
  await connection.workflowService.registerNamespace({namespace,description:"Synthetic batch2 directory and presence isolation proof; no providers",workflowExecutionRetentionPeriod:msToTs("7 days")});
  native=await NativeConnection.connect({address:deployment.address,tls});const client=new Client({connection,namespace});
  const makeWorker=async(taskQueue:string,activities:Record<string,any>)=>{const w=await Worker.create({connection:native!,namespace,taskQueue,workflowBundle:{codePath:join(dist,"catalog-proof-workflows.cjs")},activities});workers.push(w);runs.push(w.run());};
  const queue="catalog-proof", productQueue="product-proof", events:string[]=[];
  await makeWorker(queue,{
    readCatalogPage:async(input:any)=>{events.push(`page-${input.catalogId}-${input.page}`);
      if(input.page===1){assert.ok(events.includes(`dispatch-${input.catalogId}`)); if(input.catalogId==="temporal-failure")throw Error("SOURCE.NETWORK_UNAVAILABLE");}
      return catalogPage(input.catalogId,input.page,input.page===0?"more":"complete",[input.page===0?"613701":"222222"]);},
    commitCatalogPage:(p:unknown)=>ledger.commit(p),recordCatalogDispatch:async(p:any)=>{await ledger.dispatch(p);events.push(`dispatch-${p.discovery.catalogId}`);},
    closeCatalog:(p:any)=>ledger.close(p),checkPresence:(p:any)=>ledger.presence(p),
  });await makeWorker(productQueue,{});
  const histories:any[]=[];
  for(const catalogId of ["temporal-complete","temporal-failure"]){
    await check(`Railway Temporal ${catalogId}: incremental children survive parent and Continue-As-New`,async()=>{
      const h=await client.workflow.start("CatalogWorkflow",{workflowId:catalogId,taskQueue:queue,args:[{catalogId,scope:catalogScope,queues:{source:queue,ledger:queue,product:productQueue},pagesPerRun:1}],workflowExecutionTimeout:"2 minutes"});
      const outcome=await h.result();assert.deepEqual(outcome,{status:catalogId==="temporal-complete"?"complete":"incomplete"});
      const history=await h.fetchHistory();histories.push({catalogId,firstRunId:h.firstExecutionRunId,history});
      const first=await client.workflow.getHandle(catalogId,h.firstExecutionRunId).fetchHistory();assert.ok(first.events?.some(e=>!!e.workflowExecutionContinuedAsNewEventAttributes));
      await Worker.runReplayHistory({workflowBundle:{codePath:join(dist,"catalog-proof-workflows.cjs")}},first,catalogId);
      await Worker.runReplayHistory({workflowBundle:{codePath:join(dist,"catalog-proof-workflows.cjs")}},history,catalogId);
      const children=(await db!.query("SELECT execution FROM catalog_dispatch x JOIN catalog_discovery d USING(discovery_id) WHERE d.catalog_id=$1",[catalogId])).rows;
      assert.equal(children.length,catalogId==="temporal-complete"?2:1);
      for(const {execution}of children){const child=client.workflow.getHandle(execution.workflowId,execution.runId);handles.push(child);assert.equal((await child.describe()).status.name,"RUNNING");await child.signal("release");assert.deepEqual(await child.result(),{fixture:true,result:"released-after-parent-close"});}
      const status=await client.workflow.execute("PresenceWorkflow",{workflowId:`presence-${catalogId}`,taskQueue:queue,args:[{input:{operationId:`check-${catalogId}`,catalogId,scope:catalogScope,listingId:"missing",variantId:null},queue}]});assert.equal(status.status,catalogId==="temporal-complete"?"confirmed_absent":"unknown");
    });
  }
  await privateJson("temporal-histories.json",histories);
  const reviews=new PostgresReviews(db), token=randomUUID()+randomUUID(), dashboard=new PostgresDashboard(db);
  await reviews.append(reviewFixture("test-review-001"));
  const app=createApp(new PostgresBrands(db),token,{dashboard,reviews});const request=(path:string,method="GET",auth=true)=>app.request(`/api/v3${path}`,{method,headers:auth?{authorization:`Bearer ${token}`}:{}});
  await check("Dashboard API auth/read-only, genuine counts and review redaction",async()=>{
    assert.equal((await request("/dashboard","GET",false)).status,401);assert.equal((await request("/dashboard","POST")).status,404);
    const summary=DashboardSummarySchema.parse(await(await request("/dashboard")).json());assert.equal(summary.collectedProducts,0);assert.equal(summary.formalWrites,null);assert.equal(summary.reviews,1);assert.ok(summary.pendingDispatches>0);
    const response=await request("/reviews"), body=await response.text();DashboardReviewsSchema.parse(JSON.parse(body));assert.ok(!body.includes("private-token-canary")&&!body.includes("candidate-private-canary"));
    assert.equal((await request("/reviews?code=RESULT.REGISTRATION_UNKNOWN")).status,200);
    assert.equal((await request("/dashboard/products?before=%27")).status,400);
  });
  // A second empty database receives only genuine archived evidence. No synthetic catalog/review in UI.
  await db.query("CREATE DATABASE crawler_v3_dev");uiDb=connect("crawler_v3_dev");await migrateOne(uiDb);
  const archivedRoot="/Users/barry/apps/crawlv3-gnc-saved.qV5Ygp/live", archiveBytes=await readFile(join(archivedRoot,"database-evidence.json")), archived=JSON.parse(archiveBytes.toString("utf8"));
  await check("real archived product imported through existing validating registries, isolated from synthetic tests",async()=>{
    for(const {record}of archived.results){if(OcrRegistrationSchema.safeParse(record).success)await new PostgresResultRegistry(uiDb!).register(record);else if(TextRecordSchema.safeParse(record).success)await new PostgresTextRegistry(uiDb!).register(record);else{VisionRecordSchema.parse(record);await new PostgresVisionRegistry(uiDb!).register(record);}}
    for(const {record}of archived.products)await new PostgresLabelCollectedProducts(uiDb!).append(record);
    for(const {record}of archived.reviews)await new PostgresReviews(uiDb!).append(record);
    const saved=JSON.parse(await readFile(join(archivedRoot,"report.json"),"utf8"));
    const execution={clusterId:"railway",namespace:saved.namespace,workflowId:"gnc-ego-downstream-613701-30269ea7-1fe9-40f6-a538-dac64ddbf488",runId:"01a084b0-419d-7a67-8f92-61266015a0ab"};
    for(const {record}of archived.products)await uiDb!.query("INSERT INTO observation_execution(observation_id,execution) VALUES($1,$2)",[record.observation.observationId,execution]);
    const reader=new PostgresDashboard(uiDb!,[{clusterId:"railway",baseUrl:deployment.uiUrl}]);
    const summary=await reader.summary(), products=DashboardProductsSchema.parse(await reader.products());
    assert.equal(summary.processingResults,6);assert.equal(summary.processedObservations,1);assert.equal(summary.collectedProducts,1);assert.equal(summary.reviews,0);assert.equal(summary.discoveries,0);
    assert.equal(products.items[0]!.formulaRows,18);assert.equal(products.items[0]!.otherIngredients,7);assert.ok(products.items[0]!.temporalUrl?.includes(execution.runId));
    await privateJson("dashboard-evidence.json",{source:"archived real batch1, not a new crawl",archiveSha256:createHash("sha256").update(archiveBytes).digest("hex"),summary,products});
  });
  const readerPassword=randomUUID();await db.query(`CREATE ROLE v3_dashboard_reader LOGIN PASSWORD '${readerPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  for(const pool of [db,uiDb])await pool.query("GRANT USAGE ON SCHEMA public TO v3_dashboard_reader; GRANT SELECT ON ALL TABLES IN SCHEMA public TO v3_dashboard_reader");
  await privateJson("dashboard-private.json",{databaseUrl:`postgresql://v3_dashboard_reader:${readerPassword}@127.0.0.1:${port}/crawler_v3_dev`,token,ui:[{clusterId:"railway",baseUrl:deployment.uiUrl}],port:4186,dataset:"验收环境：2026-09-09 已归档真实 GNC 样本，非新一轮抓取。目录故障测试在另一数据库，不计入这里。"});
  await privateJson("review-test-private.json",{databaseUrl:`postgresql://v3_dashboard_reader:${readerPassword}@127.0.0.1:${port}/crawler_v3_test`,token,ui:[],port:4187,dataset:"合成故障测试库：目录计数和 Review 均为明确构造的测试案例，不是真实采集结果。用于检查错误详情与只读行为。"});
  success=true;
} catch(error) { console.error(JSON.stringify({event:"BATCH_TWO_FAILED",name:error instanceof Error?error.name:"unknown",message:error instanceof Error?error.message:"unknown"}));process.exitCode=1; }
finally {
  for(const h of handles)try{await h.signal("release");}catch{}
  for(const w of workers)w.shutdown();await Promise.allSettled(runs);await native?.close();await connection?.close();await db?.end();await uiDb?.end();
  if(owned&&!success)await exec("docker",["stop","--time","10",container],{timeout:20000}).catch(()=>{});
  await writeFile(join(root!,"report.json"),JSON.stringify({success,container,namespace,checks:reports,syntheticCatalog:true,liveProviderCalls:0,databaseRetained:true,uiDatabaseRunning:success},null,2),{mode:0o600}).catch(()=>{});
}
