// One fresh acquisition through three independent Workers; no models, files, navigation or input.
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { promisify, parseEnv } from "node:util";
import pg from "pg";
import { Client, Connection, type WorkflowHandle } from "@temporalio/client";
import { Worker } from "@temporalio/worker";
import { msToTs } from "@temporalio/common/lib/time.js";
import { GncAcquireInputSchema, GncParsedEvidenceSchema } from "@crawl-automation/v3-contracts";
import { createR2Objects, verifyBytes } from "@crawl-automation/v3-artifacts";
import { EgoBrowserConfigSchema } from "@crawl-automation/v3-acquisition";
import { GncCaptureEvidence } from "@crawl-automation/v3-channels";
import { TextLocalStore } from "@crawl-automation/v3-text";
import { PostgresReviews } from "@crawl-automation/v3-review";
import { taskQueueFor } from "@crawl-automation/v3-worker-runtime";
import { migrate, migrationNames } from "../../v3-api/src/bootstrap/schema.js";
import { readGncPrivateJson } from "../src/gnc-config.js";

const [flag, root, configPath] = process.argv.slice(2);
assert.equal(flag, "--authorized-ego-capture-one");
assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
assert.match(root!, /^\/Users\/barry\/apps\/crawlv3-ego-run\.[A-Za-z0-9]+\/live$/);
const dist = dirname(fileURLToPath(import.meta.url)), exec = promisify(execFile);
const parent = "/Users/barry/apps/crawlv3-gnc-e2e.FzqLa3";
const id = randomUUID(), namespace = `gnc-ego-${id}`, container = `crawlv3-ego-${id.slice(0,8)}`;
const children: { child: ChildProcess; role: string }[] = [];
let connection: Connection | undefined, handle: (WorkflowHandle & {firstExecutionRunId:string}) | undefined, db: pg.Pool | undefined;
let terminal = false, created = false, dbStarted = false;
const report: Record<string, any> = { id, namespace, container, status: "preparing", submittedWorkflows: 0, browserNavigation: 0,
  mouseInput: 0, modelCalls: 0, ocrCalls: 0, productCollected: 0, workers: [], network: "unmanaged Ego host; no fixed lane claim" };
const save = async () => { if(created) await writeFile(join(root!, "report.json"), JSON.stringify(report,null,2), {mode:0o600}); };
const privateJson = async (name:string,value:unknown) => { const p=join(root!,name);await writeFile(p,JSON.stringify(value),{mode:0o600,flag:"wx"});return p; };
async function until(check:()=>Promise<boolean>,ms=30000) { const end=Date.now()+ms;while(!await check()){if(Date.now()>end)throw Error("WAIT_TIMEOUT");await new Promise(r=>setTimeout(r,250));} }
async function main() {
  const browser=EgoBrowserConfigSchema.parse(await readGncPrivateJson(configPath!));
  await mkdir(root!,{mode:0o700});created=true;await privateJson("intent.json",{id,browser});await save();
  const env=parseEnv(await readGncEnv());assert.equal(env.CLOUDFLARE_R2_BUCKET,"supply-smart-test");
  const r2={endpoint:env.CLOUDFLARE_R2_ENDPOINT!,bucket:env.CLOUDFLARE_R2_BUCKET,prefix:`crawlv3-acceptance/ego-${id}`,timeoutMs:20000};
  const r2Credentials={accessKeyId:env.CLOUDFLARE_R2_ACCESS_KEY_ID!,secretAccessKey:env.CLOUDFLARE_R2_SECRET_ACCESS_KEY!};
  const deployment=JSON.parse(await readFile(join(parent,"deployment.json"),"utf8"));
  const transport={mode:"mtls",serverName:deployment.tlsServerName,caFile:join(parent,"ca.pem"),certFile:join(parent,"mac-worker.pem"),keyFile:join(parent,"mac-worker-key.pem")};
  connection=await Connection.connect({address:deployment.address,connectTimeout:"15 seconds",tls:{serverNameOverride:transport.serverName,
    serverRootCACertificate:await readFile(transport.caFile),clientCertPair:{crt:await readFile(transport.certFile),key:await readFile(transport.keyFile)}}});
  await connection.workflowService.registerNamespace({namespace,workflowExecutionRetentionPeriod:msToTs("7 days"),description:"One Ego GNC acquisition; not product admission"});
  const client=new Client({connection,namespace});
  const password=randomUUID();
  await writeFile(join(root!,"postgres.env"),`POSTGRES_USER=v3_admin\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=crawler_v3_test\n`,{mode:0o600,flag:"wx"});
  await mkdir(join(root!,"postgres-data"),{mode:0o700});
  await exec("docker",["run","-d","--name",container,"--label",`crawlv3.run=${id}`,"--publish","127.0.0.1::5432","--env-file",join(root!,"postgres.env"),"--mount",`type=bind,src=${join(root!,"postgres-data")},dst=/var/lib/postgresql`,"postgres:18"],{timeout:30000});dbStarted=true;
  const port=Number((await exec("docker",["port",container,"5432/tcp"])).stdout.trim().split(":").at(-1));assert.ok(port>0);
  db=new pg.Pool({host:"127.0.0.1",port,user:"v3_admin",password,database:"crawler_v3_test",connectionTimeoutMillis:2000,max:3});
  await until(async()=>{try{await db!.query("SELECT 1");return true;}catch{return false;}});
  const migrations=await Promise.all(migrationNames.map(async name=>{const sql=await readFile(join(dist,"migrations",name),"utf8");return {name,sql,sha256:createHash("sha256").update(sql).digest("hex")};}));
  const dc=await db.connect();try{await migrate(dc,migrations);}finally{dc.release();}
  const reviewPassword=randomUUID();
  await db.query(`CREATE ROLE ego_review LOGIN PASSWORD '${reviewPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  await db.query("GRANT USAGE ON SCHEMA public TO ego_review; GRANT SELECT,INSERT ON public.review_record TO ego_review");
  const reviewDatabase={connectionString:`postgresql://ego_review:${reviewPassword}@127.0.0.1:${port}/crawler_v3_test`,tls:false};
  const network={mode:"host",managed:false,routeId:"mini-ego-host",version:"ego-host/1",egressId:"ego-host/1"};
  const task=GncAcquireInputSchema.parse({schemaVersion:1,implementationVersion:"gnc-acquire/1",
    owner:{schemaVersion:1,requestId:`req-${id}`,observationId:`obs-${id}`,brandId:"acceptance-focus-fuel",sourceId:"gnc",listingId:"613701",variantId:null},
    capture:{kind:"product",requestId:`req-${id}`,operationId:`capture-${id}`,brandId:"acceptance-focus-fuel",sourceId:"gnc",url:"https://www.gnc.com/energy/613701.html",sku:"613701",binding:{sessionId:browser.sessionId,egressId:network.egressId}},network});
  await privateJson("task.json",task);report.prefix=r2.prefix;
  let workflowQueue="";
  for(const role of ["gnc-workflow","gnc-product","gnc-receipt"]) {
    const folder=join(root!,role);await mkdir(folder,{mode:0o700});
    const entry=join(dist,role==="gnc-workflow"?"gnc-workflow-worker.js":"gnc-worker.js");
    const config={role,r2,r2Credentials,reviewDatabase,journalRoot:join(folder,"journal"),...(role==="gnc-product"?{network,browser,grants:[{task,expiresAt:new Date(Date.now()+600000).toISOString()}]}:{})};
    const cfg=await privateJson(`${role}/private.json`,config);
    const metadata=JSON.parse((await exec(process.execPath,[entry,"--list"],{timeout:30000})).stdout).find((m:any)=>m.role===role);assert.ok(metadata);
    const runtime={role,capability:metadata.capability,compatibility:metadata.compatibility,contractVersion:metadata.contractVersion,expectedBuildId:metadata.buildId,
      address:deployment.address,namespace,transport,hostId:`ego-${role}`,concurrency:metadata.kind==="workflow"?2:1,startupTimeoutMs:60000,shutdownGraceMs:10000,shutdownForceMs:20000};
    const runtimePath=await privateJson(`${role}/runtime.json`,runtime);
    const logfile=join(folder,"worker.log"),file=await open(logfile,"ax",0o600);
    const child=spawn(process.execPath,[entry],{env:{...process.env,V3_WORKER_ENABLED:"true",V3_WORKER_CONFIG:runtimePath,V3_GNC_LIVE_ENABLED:"true",V3_GNC_CONFIG:cfg},stdio:["ignore",file.fd,file.fd]});
    children.push({child,role});await file.close();
    await until(async()=>{if(child.exitCode!==null||child.signalCode!==null)throw Error("WORKER_START_FAILED");return (await readFile(logfile,"utf8")).includes('"event":"WORKER_RUNNING"');},65000);
    const queue=taskQueueFor(runtime);if(role==="gnc-workflow")workflowQueue=queue;
    report.workers.push({role,pid:child.pid,queue});await save();console.log(JSON.stringify({event:"READY",role}));
  }
  const workflowId=`ego-613701-${id}`;await privateJson("submit-intent.json",{namespace,workflowId});
  handle=await client.workflow.start("GncCaptureWorkflow",{workflowId,taskQueue:workflowQueue,args:[{task}],workflowExecutionTimeout:"5 minutes"});
  report.submittedWorkflows=1;report.workflowId=workflowId;report.runId=handle.firstExecutionRunId;
  report.ui=`${deployment.uiUrl}/namespaces/${namespace}/workflows/${workflowId}/${handle.firstExecutionRunId}/history`;await save();
  report.outcome=await handle.result();terminal=true;
  const history=await handle.fetchHistory();await privateJson("history.json",history);
  await Worker.runReplayHistory({workflowBundle:{codePath:join(dist,"gnc-workflows.cjs")}},history);report.replay=true;
  const remote=createR2Objects(r2,r2Credentials);
  try {
    const counts={get:0,put:0};
    const readonly={read:async(...args:Parameters<typeof remote.store.read>)=>{counts.get++;return remote.store.read(...args);},
      create:async()=>{counts.put++;throw Error("COLD_WRITE_FORBIDDEN");}};
    const evidence=new GncCaptureEvidence({local:await TextLocalStore.open(join(root!,"cold-journal")),remote:readonly,reviews:new PostgresReviews(db)});
    const record=await evidence.inspect(task,AbortSignal.timeout(30000));
    if(report.outcome.status==="durable") {
      assert.ok(record);assert.deepEqual(evidence.receipt(record),report.outcome);
      const bytes=await remote.store.read(record.evidence.objectKey,8388608,AbortSignal.timeout(30000));assert.ok(bytes);verifyBytes(record.evidence,bytes,8388608);
      const parsed=GncParsedEvidenceSchema.parse(JSON.parse(Buffer.from(bytes).toString()));assert.equal(parsed.kind,"product");
      if(parsed.kind==="product"){report.sku=parsed.data.sku;report.images=parsed.data.imageCandidates.length;report.factsDomPresent=!!parsed.data.factsHtml;}
    }
    report.cold=counts;
  } finally {remote.close();}
  report.reviewRows=(await db.query("SELECT review_id,record->'failure'->>'code' AS code FROM review_record")).rows;
  report.collectedRows=(await db.query("SELECT operation_id FROM collected_product")).rows;
  report.status="finished";await save();
}
async function readGncEnv() {
  const f=await open("/Users/barry/apps/crawlv3-gnc-live-ioVGhu/.env.r2",constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const s=await f.stat();assert.ok(s.isFile()&&s.size<8192&&!(s.mode&0o077));return await f.readFile("utf8");}finally{await f.close();}
}
await main().catch(async(error)=>{report.status="needs-inspection";report.error=error instanceof Error&&/^[A-Z_.]{1,100}$/.test(error.message)?error.message:"INSPECT_PRIVATE_LOGS";process.exitCode=1;}).finally(async()=>{
  if(handle&&!terminal)try{await handle.cancel();report.cancelRequested=true;}catch{report.cancelUnknown=true;}
  if(handle&&report.status!=="finished")try{await privateJson("failure-history.json",await handle.fetchHistory());}catch{report.historyUnknown=true;}
  for(const {child,role} of children.reverse()) {
    if(child.exitCode===null&&child.signalCode===null)child.kill("SIGTERM");
    try{await until(async()=>child.exitCode!==null||child.signalCode!==null,35000);const record=report.workers.find((w:any)=>w.role===role);if(record)record.stopped=true;}
    catch{report.cleanupUnknown=true;}
  }
  await db?.end();
  if(dbStarted)try{await exec("docker",["stop",container],{timeout:30000});report.databaseStopped=true;}catch{report.cleanupUnknown=true;}
  await connection?.close();await save();console.log(JSON.stringify({root,status:report.status,outcome:report.outcome?.status,workflowId:report.workflowId,images:report.images,cold:report.cold}));
});
