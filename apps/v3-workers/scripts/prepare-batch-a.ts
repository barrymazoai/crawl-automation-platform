// Creates a NEW isolated deployment only. Does not submit a Workflow or operate a browser.
import assert from "node:assert/strict";
import { randomUUID,createHash } from "node:crypto";
import { mkdir,readFile,writeFile,readdir } from "node:fs/promises";
import { dirname,join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { parseEnv,promisify } from "node:util";
import { execFile } from "node:child_process";
import pg from "pg";
import { Connection } from "@temporalio/client";
import { msToTs } from "@temporalio/common/lib/time.js";
import { artifactBuildId,taskQueueFor } from "@crawl-automation/v3-worker-runtime";
import { CodexTextProvider } from "@crawl-automation/v3-text";
import { CodexVisionProvider } from "@crawl-automation/v3-vision";
import { MultipartOcr } from "@crawl-automation/v3-ocr";
import { PostgresBrands } from "../../v3-api/src/storage/postgres-brands.js";
import { migrate,migrationNames } from "../../v3-api/src/bootstrap/schema.js";
import { BrandPipelineConfig } from "../src/brand-pipeline.js";
import { DeploymentSchema } from "../src/deployment-supervisor.js";
import { readGncPrivateJson } from "../src/gnc-config.js";
const [flag,root]=process.argv.slice(2),resume=flag==="--resume-empty-deployment";assert.ok(resume||flag==="--new-isolated-deployment");assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
assert.match(root!,/^\/Users\/barry\/apps\/crawlv3-batch-a\.[A-Za-z0-9]+\/live$/);
const dist=dirname(fileURLToPath(import.meta.url)),base=dirname(root!),previous="/Users/barry/apps/crawlv3-gnc-saved.qV5Ygp/live",credentials="/Users/barry/apps/crawlv3-gnc-e2e.FzqLa3",exec=promisify(execFile);
const priorIntent=resume?await readGncPrivateJson(join(root!,"intent.json")) as any:null;
const id=resume?priorIntent.id:randomUUID(),namespace=`batch-a-${id}`,container=`crawlv3-batch-a-${id.slice(0,8)}`;
if(resume){assert.equal(priorIntent.namespace,namespace);assert.equal(priorIntent.container,container);assert.equal(priorIntent.submitted,0);}
let db:pg.Pool|undefined,connection:Connection|undefined,created=false,success=false;
const json=async(name:string,value:unknown)=>{const path=join(root!,name);await writeFile(path,JSON.stringify(value,null,2),{mode:0o600,flag:"wx"});return path;};
try{
  if(!resume){await mkdir(root!,{mode:0o700});await json("intent.json",{id,namespace,container,browserCalls:0,submitted:0});}
  const password=resume?parseEnv(await readFile(join(root!,"postgres.env"),"utf8")).POSTGRES_PASSWORD!:randomUUID();
  if(!resume){await writeFile(join(root!,"postgres.env"),`POSTGRES_USER=v3_admin\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=crawler_v3_test\n`,{mode:0o600,flag:"wx"});await mkdir(join(root!,"postgres-data"),{mode:0o700});
    await exec("docker",["run","-d","--name",container,"--label",`crawlv3.batch-a=${id}`,"--publish","127.0.0.1::5432","--env-file",join(root!,"postgres.env"),"--mount",`type=bind,src=${join(root!,"postgres-data")},dst=/var/lib/postgresql`,"postgres:18"],{timeout:30000});
  }else{
    const inspection=JSON.parse((await exec("docker",["inspect",container])).stdout)[0];assert.equal(inspection.Config.Labels["crawlv3.batch-a"],id);assert.equal(inspection.State.Running,false);
    assert.ok(inspection.Mounts.some((m:any)=>m.Source===join(root!,"postgres-data")));await exec("docker",["start",container],{timeout:30000});
  }created=true;
  const port=Number((await exec("docker",["port",container,"5432/tcp"])).stdout.trim().split(":").at(-1));assert.ok(port>0);
  const database={connectionString:`postgresql://v3_admin:${password}@127.0.0.1:${port}/crawler_v3_test`,tls:false};
  db=new pg.Pool({...database,connectionString:database.connectionString,max:6,connectionTimeoutMillis:2000,statement_timeout:10000});
  const deadline=Date.now()+30000;for(;;){try{await db.query("SELECT 1");break;}catch{if(Date.now()>deadline)throw Error("POSTGRES_TIMEOUT");await new Promise(r=>setTimeout(r,200));}}
  if(resume){assert.equal((await db.query("SELECT count(*)::int AS n FROM brand")).rows[0].n,0);assert.equal((await db.query("SELECT count(*)::int AS n FROM collection_submission")).rows[0].n,0);}
  const migrations=await Promise.all(migrationNames.map(async name=>{const sql=await readFile(join(dist,"migrations",name),"utf8");return{name,sql,sha256:createHash("sha256").update(sql).digest("hex")};}));
  const client=await db.connect();try{await migrate(client,migrations);}finally{client.release();}
  // This existing file is public endpoint metadata (0644), not a credential file.
  const metadata=JSON.parse(await readFile(join(credentials,"deployment.json"),"utf8"));
  const deployment={address:metadata.address,tlsServerName:metadata.tlsServerName,uiUrl:metadata.uiUrl};
  const transport={mode:"mtls",serverName:deployment.tlsServerName,caFile:join(credentials,"ca.pem"),certFile:join(credentials,"mac-worker.pem"),keyFile:join(credentials,"mac-worker-key.pem")};
  connection=await Connection.connect({address:deployment.address,connectTimeout:"20 seconds",tls:{serverNameOverride:transport.serverName,serverRootCACertificate:await readFile(transport.caFile),clientCertPair:{crt:await readFile(transport.certFile),key:await readFile(transport.keyFile)}}});
  await connection.workflowService.registerNamespace({namespace,description:"Batch A bounded FocusFuel Brand acceptance; isolated V3 data",workflowExecutionRetentionPeriod:msToTs("7 days")});
  const brands=new PostgresBrands(db),brand=(await brands.create({name:"FocusFuel",note:"A批真实GNC目录验收；非生产"},randomUUID())).value;
  const source=(await brands.createSource(brand.id,{channel:"gnc",region:"US",url:"https://www.gnc.com/brands/focus-fuel/"},randomUUID())).value;
  const enabled=(await brands.toggleSource(brand.id,source.id,{enabled:true,revision:source.revision},randomUUID())).value;
  const scope={brandId:brand.id,sourceId:source.id,channel:"gnc",region:"US",rootUrl:source.url,scopeVersion:`source-revision-${enabled.revision}`};
  const oldConfig=await readGncPrivateJson(join(previous,"codex-text/private.json")) as any;
  const storage={r2:{...oldConfig.r2,prefix:`crawlv3-acceptance/batch-a-${id}`},r2Credentials:oldConfig.r2Credentials};
  const storageId=`batch-a-${id.slice(0,8)}`;
  const remap=(value:any,key=""):any=>{
    if(key==="r2")return storage.r2;if(key==="r2Credentials")return storage.r2Credentials;if(key==="storageId")return storageId;
    if(value&&typeof value==="object"&&"connectionString" in value)return database;
    if(Array.isArray(value))return value.map(v=>remap(v));
    if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,remap(v,k)]));
    return typeof value==="string"&&value.startsWith(previous)?root!+value.slice(previous.length):value;
  };
  const codeFiles=(await readdir(dist)).filter(n=>n.endsWith(".js")).sort().map(n=>join(dist,n)),activityBuild=await artifactBuildId(codeFiles);
  const workflowBuild=await artifactBuildId([...codeFiles,join(dist,"product-workflows.cjs")].sort());
  const jobs:any[]=[],queues:Record<string,string>={},configs:Record<string,any>={};
  async function define(key:string,role:string,entry:string,capability:string,compatibility:string,config:any,variable?:string,concurrency=1,workflow=false){
    const roleRoot=join(root!,role);await mkdir(roleRoot,{recursive:true,mode:0o700});
    const runtime={role,capability,contractVersion:1,compatibility,expectedBuildId:workflow?workflowBuild:activityBuild,hostId:`mini-${role}`,namespace,address:deployment.address,transport,concurrency,startupTimeoutMs:120000,shutdownGraceMs:10000,shutdownForceMs:20000};
    const env:Record<string,string>={V3_WORKER_ENABLED:"true",V3_WORKER_CONFIG:await json(`${role}/runtime.json`,runtime)};
    if(variable){env[`${variable}_CONFIG`]=await json(`${role}/private.json`,config);env[`${variable}_LIVE_ENABLED`]="true";}
    configs[key]=config;queues[key]=taskQueueFor(runtime);jobs.push({id:role,entry:join(dist,`${entry}.js`),env});
  }
  const priorRoles=[
    ["plan","gnc-core-plan","product-worker","V3_PRODUCT"],["source","gnc-core-source","product-worker","V3_PRODUCT"],["manifest","gnc-core-input","product-worker","V3_PRODUCT"],
    ["assembly","product-core-assembly","product-worker","V3_PRODUCT"],["collection","product-core-collect","product-worker","V3_PRODUCT"],["ocrReceipts","ocr-receipt","product-worker","V3_PRODUCT"],
    ["page","page-prepare","acquisition-worker","V3_ACQUISITION"],["pageText","page-text-input","acquisition-worker","V3_ACQUISITION"],["imagePrepare","image-ocr-input","acquisition-worker","V3_ACQUISITION"],
    ["core","label-core-prepare","acquisition-worker","V3_ACQUISITION"],["ocr","ocr-file","ocr-worker","V3_OCR"],["keywords","ocr-keywords","keyword-worker","V3_KEYWORD"],
    ["acquireReceipts","file-receipt","acquisition-worker","V3_ACQUISITION"],
    ["text","codex-text","text-worker","V3_TEXT"],["textReceipts","text-receipt","text-receipt-worker","V3_TEXT_RECEIPT"],["vision","codex-vision","vision-worker","V3_VISION"],
  ];
  for(const [key,role,entry,variable] of priorRoles){
    const template=await readGncPrivateJson(join(previous,role!,"runtime.json")) as any,config=remap(await readGncPrivateJson(join(previous,role!,"private.json")));
    await define(key!,role!,entry!,template.capability,template.compatibility,config,variable,["ocr","keywords"].includes(key!)?2:1);
  }
  for(const [key,role] of [["captureReceipts","gnc-receipt"],["productPlan","gnc-product-input"]])await define(key!,role!,"gnc-worker",role!.replace("-","."),role==="gnc-receipt"?"gnc-v1":"gnc-input-v1",{...storage,role,journalRoot:join(root!,"source-journal"),reviewDatabase:database},"V3_GNC");
  const network={routeId:"mini-default-ego",version:"host-v1",mode:"host",managed:false,egressId:"mini-default-ego"};
  const live={...storage,database,journalRoot:join(root!,"source-journal"),pageJournalRoot:join(root!,"browser-pages"),cacheRoot:join(root!,"source-cache"),network,browserResource:"mini-ego-space-1",
    browser:{engine:"ego-lite",sdk:"1",cliPath:"/Users/barry/.local/bin/ego-browser",taskSpaceId:1,targetId:"CFA43A1013F035858F941C1F61B0F49D",sessionId:"configured-at-runtime"},allowedImageOrigins:["https://www.gnc.com"]};
  for(const [key,role,cap] of [["capture","gnc-live-capture","gnc.live.capture"],["acquire","gnc-live-file","gnc.live.file"]]){
    await define(key!,role!,"live-gnc-worker",cap!,"gnc-live-v1",live,"V3_LIVE_GNC");const env=jobs.at(-1).env;delete env.V3_LIVE_GNC_LIVE_ENABLED;env.V3_LIVE_GNC_ENABLED="true";
  }
  await define("resource","resource-admission","resource-worker","resource.admission","resource-v1",{database},"V3_RESOURCE");delete jobs.at(-1).env.V3_RESOURCE_LIVE_ENABLED;jobs.at(-1).env.V3_RESOURCE_ENABLED="true";
  for(const [key,role,cap,compat] of [["workflow","gnc-core-stream-workflow","gnc.stream-label.workflow","gnc-core-v1"],["catalogWorkflow","catalog-workflow","catalog.workflow","catalog-v1"],["productWorkflow","catalog-product-workflow","catalog.product.workflow","catalog-product-v1"],["brandWorkflow","brand-collection-workflow","brand.collection.workflow","brand-v1"]])
    await define(key!,role!,"product-workflow-worker",cap!,compat!,undefined,undefined,2,true);
  const resourceQueue=queues.resource!,browserNeeds=[{resourceId:live.browserResource,units:1}],modelNeeds=[{resourceId:"mini-model-account",units:1},{resourceId:"mini-cpu",units:1}];
  const productQueues=Object.fromEntries(Object.entries(queues).filter(([key])=>!["resource","workflow","catalogWorkflow","productWorkflow","brandWorkflow"].includes(key)));
  const policy={codec:"gnc-catalog-product-policy/1",catalogId:"runtime-submission",scope,network,browserPhase:true,
    sourceText:CodexTextProvider.describe({...configs.text.codex,extractionProtocol:undefined}),ocr:new MultipartOcr(configs.ocr.provider).supported,
    sourceVisionConfigFingerprint:CodexVisionProvider.describe(configs.vision.codex).configFingerprint,text:CodexTextProvider.describe(configs.text.codex),visionConfigFingerprint:CodexVisionProvider.describe(configs.vision.codex).configFingerprint,
    corePolicy:"gnc-label-core/1",queues:productQueues,queue:queues.workflow,resources:{queue:resourceQueue,activities:{browserSession:browserNeeds,interpretText:modelNeeds,interpretImage:modelNeeds,ocrFile:[{resourceId:"windows-ocr",units:1}]}}};
  const catalogQueues={source:taskQueueFor({capability:"catalog.live.source",contractVersion:1,compatibility:"catalog-live-v1"}),ledger:taskQueueFor({capability:"catalog.live.ledger",contractVersion:1,compatibility:"catalog-live-v1"}),product:queues.productWorkflow};
  const pipeline=BrandPipelineConfig.parse({...live,browser:{...live.browser,targetId:"2C727DC3F617F4790392840BDF6735F0"},clusterId:"railway-temporal",policy,catalogQueue:queues.catalogWorkflow,catalogQueues,maxPages:1,resources:{queue:resourceQueue,activities:{readCatalogPage:browserNeeds}}});
  for(const [key,role,cap,compat] of [["brandControl","brand-collection-control","brand.collection.workflow","brand-v1"],["catalogSource","catalog-live-source","catalog.live.source","catalog-live-v1"],["catalogLedger","catalog-live-ledger","catalog.live.ledger","catalog-live-v1"],["productInput","catalog-live-product-input","catalog.product.workflow","catalog-product-v1"]]){
    await define(key!,role!,"brand-pipeline-worker",cap!,compat!,pipeline,"V3_BRAND_PIPELINE");delete jobs.at(-1).env.V3_BRAND_PIPELINE_LIVE_ENABLED;jobs.at(-1).env.V3_BRAND_PIPELINE_ENABLED="true";
  }
  const ui=[{clusterId:"railway-temporal",baseUrl:deployment.uiUrl}],target={clusterId:"railway-temporal",namespace,taskQueue:queues.brandWorkflow,workflowType:"BrandCollectionWorkflow"};
  const web={databaseUrl:database.connectionString,token:randomUUID()+randomUUID(),port:4188,webRoot:join(base,"web"),ui,delivery:{target,address:deployment.address,transport,pauseFile:join(root!,"delivery-paused"),batchSize:10,concurrency:2,intervalMs:2000}};
  const webConfig=await json("web.json",web);jobs.push({id:"brand-web",entry:join(dist,"brand-web.js"),env:{V3_BRAND_WEB_ENABLED:"true",V3_BRAND_WEB_CONFIG:webConfig}});
  const manifest=DeploymentSchema.parse({platform:"darwin",host:hostname(),root:base,node:process.execPath,database,jobs,resources:[
    {resourceId:live.browserResource,capacity:1,jobs:["gnc-live-capture","gnc-live-file","catalog-live-source"],minFreeBytes:1024*1024*1024},
    {resourceId:"mini-cpu",capacity:2,jobs:["codex-text","codex-vision"],minFreeBytes:1024*1024*1024},
    {resourceId:"mini-model-account",capacity:1,jobs:["codex-text","codex-vision"],minFreeBytes:1024*1024*1024},
    {resourceId:"windows-ocr",capacity:2,jobs:["ocr-file"],minFreeBytes:0},
  ]});
  const manifestPath=await json("deployment.json",manifest);
  await json("ready.json",{id,namespace,container,brandId:brand.id,sourceId:source.id,sourceRevision:enabled.revision,root,manifestPath,workers:jobs.length,url:"http://127.0.0.1:4188/v3-live.html",temporalUi:`${deployment.uiUrl}/namespaces/${namespace}/workflows`,prefix:storage.r2.prefix,model:configs.text.codex.settings,submitted:0});
  success=true;console.log(JSON.stringify({event:"BATCH_A_PREPARED",root,workers:jobs.length,namespace,submitted:0}));
}finally{await connection?.close();await db?.end();if(created&&!success)await exec("docker",["stop",container],{timeout:30000});}
