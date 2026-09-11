// Acceptance only: reuse immutable capture, four independent file workflows, no page recrawl or providers.
import assert from "node:assert/strict";
import {spawn,execFile,type ChildProcess} from "node:child_process";
import {mkdir,open,readFile,writeFile} from "node:fs/promises";
import {hostname} from "node:os";
import {join,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {randomUUID} from "node:crypto";
import {promisify} from "node:util";
import pg from "pg";
import {Client,Connection} from "@temporalio/client";
import {Worker,NativeConnection} from "@temporalio/worker";
import {msToTs} from "@temporalio/common/lib/time.js";
import {GncAcquireInputSchema,GncProductInputSchema,GNC_PRODUCT_QUEUES} from "@crawl-automation/v3-contracts";
import {createR2Objects,FileCopies,type ObjectStore} from "@crawl-automation/v3-artifacts";
import {FileEvidence} from "@crawl-automation/v3-acquisition";
import {GncCaptureEvidence,GncProductPlans} from "@crawl-automation/v3-channels";
import {TextLocalStore,CodexTextProvider} from "@crawl-automation/v3-text";
import {CodexVisionProvider} from "@crawl-automation/v3-vision";
import {MultipartOcr} from "@crawl-automation/v3-ocr";
import {PostgresReviews} from "@crawl-automation/v3-review";
import {readGncPrivateJson,GncWorkerConfigSchema} from "../src/gnc-config.js";

const [flag,root]=process.argv.slice(2);
assert.equal(flag,"--authorized-ego-files-four");assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
assert.match(root!,/^\/Users\/barry\/apps\/crawlv3-ego-files\.[A-Za-z0-9]+\/live$/);
const prior="/Users/barry/apps/crawlv3-ego-run.yxECsE/live",dist=dirname(fileURLToPath(import.meta.url)),exec=promisify(execFile);
const id=randomUUID(),namespace=`ego-files-${id}`,queue=`ego-file-acceptance-${id}`;
const container="crawlv3-ego-1b5c6c59";
const report:Record<string,any>={id,namespace,container,status:"preparing",outcomes:[],browserNavigation:0,ocrCalls:0,modelCalls:0,productCollected:0};
let created=false,started=false,db:pg.Pool|undefined,connection:Connection|undefined,native:NativeConnection|undefined,child:ChildProcess|undefined;
let remote:ReturnType<typeof createR2Objects>|undefined;
const save=async()=>{if(created)await writeFile(join(root!,"report.json"),JSON.stringify(report,null,2),{mode:0o600});};
const json=async(name:string,value:unknown)=>{const path=join(root!,name);await writeFile(path,JSON.stringify(value),{mode:0o600,flag:"wx"});return path;};
async function until(check:()=>Promise<boolean>,ms=30000){const end=Date.now()+ms;while(!await check()){if(Date.now()>end)throw Error("WAIT_TIMEOUT");await new Promise(r=>setTimeout(r,250));}}
async function main(){
  const base=GncWorkerConfigSchema.parse(await readGncPrivateJson(join(prior,"gnc-product/private.json")));
  assert.equal(base.role,"gnc-product");if(base.role!=="gnc-product")throw Error("CONFIG_MISMATCH");
  assert.ok("engine" in base.browser);if(!("engine" in base.browser))throw Error("CONFIG_MISMATCH");
  const task=GncAcquireInputSchema.parse(JSON.parse(await readFile(join(prior,"task.json"),"utf8")));
  assert.equal(task.capture.url,"https://www.gnc.com/energy/613701.html");assert.equal(task.network.mode,"host");
  assert.equal(base.r2.bucket,"supply-smart-test");assert.equal(base.r2.prefix,"crawlv3-acceptance/ego-1b5c6c59-9e96-49f5-a185-41ffa9d5a5d8");
  const runtime:any=await readGncPrivateJson(join(prior,"gnc-product/runtime.json"));
  await mkdir(root!,{mode:0o700});created=true;await json("intent.json",{id,captureOperation:task.capture.operationId});await save();
  const info=JSON.parse((await exec("docker",["inspect",container])).stdout)[0];
  assert.equal(info.Config.Labels["crawlv3.run"],"1b5c6c59-9e96-49f5-a185-41ffa9d5a5d8");assert.equal(info.State.Running,false);
  await exec("docker",["start",container],{timeout:30000});started=true;
  const port=Number((await exec("docker",["port",container,"5432/tcp"])).stdout.trim().split(":").at(-1));assert.ok(port>0);
  const dbUrl=new URL(base.reviewDatabase.connectionString);dbUrl.port=String(port);
  const reviewDatabase={connectionString:dbUrl.href,tls:false};db=new pg.Pool({...reviewDatabase,connectionTimeoutMillis:2000,max:2});
  await until(async()=>{try{await db!.query("SELECT 1");return true;}catch{return false;}});
  remote=createR2Objects(base.r2,base.r2Credentials);
  const evidence=new GncCaptureEvidence({local:await TextLocalStore.open(join(root!,"prepare-journal")),remote:remote.store,reviews:new PostgresReviews(db)});
  const codex={settings:{provider:"openai",model:"gpt-5.6-luna",reasoningEffort:"medium"},executable:"/opt/homebrew/bin/codex",codexHome:"/Users/barry/.codex",
    workRoot:join(root!,"unused-model-work"),runtimeProfileVersion:"gnc-persistent-auth/1",timeoutMs:240000,disabledMcpServers:["node_repl","computer-use"]};
  const text=CodexTextProvider.describe(codex),vision=CodexVisionProvider.describe({...codex,extractionProtocol:"label-extraction/1"});
  const ocr=new MultipartOcr({endpoint:"http://192.168.0.6:8081/ocr",trustedHttpOrigin:"http://192.168.0.6:8081",provider:"paddle-ocr/1",minScore:0.3}).supported;
  const input=GncProductInputSchema.parse({operationId:`ego-plan-${id}`,task,text,ocr,visionConfigFingerprint:vision.configFingerprint});
  const plans=new GncProductPlans(evidence),prepared=await plans.run({input,receipt:null},AbortSignal.timeout(60000));
  report.prepared=prepared.status;await json("product-input.json",input);await save();assert.equal(prepared.status,"prepared");
  const plan=await plans.inspect(input,AbortSignal.timeout(60000));assert.ok(plan);
  const files=plan.manifest.sources.filter(s=>s.kind==="file-image");assert.equal(files.length,4);
  const urls:string[]=[];for(const f of files)urls.push(await plans.fileSource(input,f.plan.acquire,AbortSignal.timeout(60000)));
  assert.ok(urls.every(url=>new URL(url).origin==="https://www.gnc.com"));
  const expiresAt=new Date(Date.now()+20*60000).toISOString();
  const config=GncWorkerConfigSchema.parse({r2:base.r2,r2Credentials:base.r2Credentials,role:"gnc-file",network:task.network,
    journalRoot:join(root!,"file-journal"),cacheRoot:join(root!,"file-cache"),reviewDatabase,
    ego:{browser:base.browser,pageUrl:task.capture.url,allowedUrls:urls},
    fileGrants:[{input,allowedOrigins:["https://www.gnc.com"],expiresAt,resources:files.map((f,i)=>({input:f.plan.acquire,url:urls[i],expiresAt,headers:{}}))}]});
  const cfg=await json("file-private.json",config);
  const entry=join(dist,"gnc-worker.js"),meta=JSON.parse((await exec(process.execPath,[entry,"--list"])).stdout).find((m:any)=>m.role==="gnc-file");assert.ok(meta);
  const workerRuntime={...runtime,role:meta.role,capability:meta.capability,compatibility:meta.compatibility,expectedBuildId:meta.buildId,namespace,hostId:`ego-file-${id}`,concurrency:1};
  const rt=await json("file-runtime.json",workerRuntime);
  const tls={serverNameOverride:runtime.transport.serverName,serverRootCACertificate:await readFile(runtime.transport.caFile),
    clientCertPair:{crt:await readFile(runtime.transport.certFile),key:await readFile(runtime.transport.keyFile)}};
  connection=await Connection.connect({address:runtime.address,tls,connectTimeout:"15 seconds"});
  await connection.workflowService.registerNamespace({namespace,workflowExecutionRetentionPeriod:msToTs("7 days"),description:"Four file-only Ego acceptance workflows"});
  native=await NativeConnection.connect({address:runtime.address,tls});const client=new Client({connection,namespace});
  const workflow=await Worker.create({connection:native,namespace,taskQueue:queue,workflowBundle:{codePath:join(dist,"ego-file-acceptance.cjs")},maxConcurrentWorkflowTaskExecutions:2});
  const log=join(root!,"worker.log"),fd=await open(log,"ax",0o600);
  child=spawn(process.execPath,[entry],{env:{...process.env,V3_WORKER_ENABLED:"true",V3_WORKER_CONFIG:rt,V3_GNC_LIVE_ENABLED:"true",V3_GNC_CONFIG:cfg},stdio:["ignore",fd.fd,fd.fd]});await fd.close();report.fileWorkerPid=child.pid;
  await until(async()=>{if(child!.exitCode!==null||child!.signalCode!==null)throw Error("WORKER_START_FAILED");return (await readFile(log,"utf8")).includes('"event":"WORKER_RUNNING"');},65000);
  report.fileQueue=GNC_PRODUCT_QUEUES.files;await save();
  await workflow.runUntil(async()=>{
    for(const [index,file] of files.entries()){
      const workflowId=`ego-image-${index}-${id}`;await json(`submit-${index}.json`,{workflowId,input:file.plan.acquire});
      const handle=await client.workflow.start("EgoFileAcceptance",{workflowId,taskQueue:queue,args:[file.plan.acquire],workflowExecutionTimeout:"3 minutes"});
      const output=await handle.result();report.outcomes.push({index,workflowId,output});await save();
      const history=await handle.fetchHistory();await json(`history-${index}.json`,history);
      await Worker.runReplayHistory({workflowBundle:{codePath:join(dist,"ego-file-acceptance.cjs")}},history);
      console.log(JSON.stringify({event:"FILE_TERMINAL",index,status:output.status,code:output.code}));
      // A user-control boundary stops the entire batch; never proceed using another API/space.
      if(output.status==="review")throw Error(output.code);
    }
  });
  report.replay=true;
  const counts={get:0,put:0};const readonly:ObjectStore={read:async(...args)=>{counts.get++;return remote!.store.read(...args);},create:async()=>{counts.put++;throw Error("COLD_WRITE_FORBIDDEN");}};
  const cold=new FileEvidence({local:await TextLocalStore.open(join(root!,"cold-journal")),remote:readonly,copies:await FileCopies.open(join(root!,"cold-cache")),reviews:new PostgresReviews(db)});
  report.files=[];for(const f of files){const r=await cold.inspect(f.plan.acquire,AbortSignal.timeout(30000));assert.ok(r);report.files.push({file:r.file,dimensions:r.dimensions,redirects:r.redirects});}
  report.cold=counts;report.reviewRows=(await db.query("SELECT review_id,record->'failure'->>'code' AS code FROM review_record")).rows;
  report.status="finished";await save();
}
await main().catch(error=>{report.status="needs-inspection";report.error=error instanceof Error&&/^[A-Z_.]{1,100}$/.test(error.message)?error.message:"INSPECT_PRIVATE_LOGS";process.exitCode=1;}).finally(async()=>{
  if(child){if(child.exitCode===null&&child.signalCode===null)child.kill("SIGTERM");try{await until(async()=>child!.exitCode!==null||child!.signalCode!==null,35000);report.fileWorkerStopped=true;}catch{report.cleanupUnknown=true;}}
  await native?.close();await connection?.close();remote?.close();await db?.end();
  if(started)try{await exec("docker",["stop",container],{timeout:30000});report.databaseStopped=true;}catch{report.cleanupUnknown=true;}
  await save();console.log(JSON.stringify({root,status:report.status,error:report.error,files:report.files?.length,cold:report.cold}));
});
