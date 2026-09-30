// Before first start only: seal generated runtime configurations to the deployed artifact bytes.
import assert from "node:assert/strict";
import { readdir,readFile,writeFile,rename,lstat,mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname,join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import pg from "pg";
import { artifactBuildId } from "@crawl-automation/v3-worker-runtime";
import { DeploymentSchema } from "../src/deployment-supervisor.js";
import { readGncPrivateJson } from "../src/gnc-config.js";
import { BrandPipelineConfig } from "../src/brand-pipeline.js";
const root=process.argv[2];assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);assert.match(root!,/^\/Users\/barry\/apps\/crawlv3-batch-a\.[A-Za-z0-9]+\/live$/);
const manifest=DeploymentSchema.parse(await readGncPrivateJson(join(root!,"deployment.json")));
await assert.rejects(lstat(join(manifest.root,"supervisor.lock")),{code:"ENOENT"});
const db=new pg.Pool({connectionString:manifest.database.connectionString,connectionTimeoutMillis:5000,statement_timeout:5000});
try{
  assert.equal((await db.query("SELECT count(*)::int AS n FROM collection_submission")).rows[0].n,0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM resource_permit")).rows[0].n,0);
  const dist=dirname(fileURLToPath(import.meta.url)),files=(await readdir(dist)).filter(n=>n.endsWith(".js")).sort().map(n=>join(dist,n));
  const activity=await artifactBuildId(files),workflow=await artifactBuildId([...files,join(dist,"product-workflows.cjs")].sort());
  async function replace(path:string,value:unknown){
    assert.ok(path.startsWith(root!+"/"));const version=randomUUID();await writeFile(`${path}.before-${version}`,await readFile(path),{mode:0o600,flag:"wx"});
    const temp=`${path}.${version}.tmp`;await writeFile(temp,JSON.stringify(value),{mode:0o600,flag:"wx"});await rename(temp,path);
  }
  // Provision the read-only handoff as its own module before the first submission.
  if(!manifest.jobs.some(j=>j.id==="file-receipt")){
    const folder=join(root!,"file-receipt");await mkdir(folder,{mode:0o700});
    const runtime=await readGncPrivateJson(join(root!,"image-ocr-input/runtime.json")) as any;
    Object.assign(runtime,{role:"file-receipt",capability:"file.receipt",compatibility:"acquisition-v1",hostId:"mini-file-receipt",expectedBuildId:activity});
    const config=await readGncPrivateJson(join(root!,"image-ocr-input/private.json")) as any;
    config.cacheRoot=join(folder,"cache");config.journalRoot=join(folder,"journal");
    for(const [name,value] of [["runtime",runtime],["private",config]])await writeFile(join(folder,`${name}.json`),JSON.stringify(value),{mode:0o600,flag:"wx"});
    manifest.jobs.push({id:"file-receipt",entry:join(dist,"acquisition-worker.js"),env:{V3_WORKER_ENABLED:"true",V3_WORKER_CONFIG:join(folder,"runtime.json"),V3_ACQUISITION_LIVE_ENABLED:"true",V3_ACQUISITION_CONFIG:join(folder,"private.json")}});
    await replace(join(root!,"deployment.json"),DeploymentSchema.parse(manifest));
  }
  for(const role of ["schedule-intake-workflow","schedule-intake-control"]){
    if(manifest.jobs.some(j=>j.id===role))continue;
    const isWorkflow=role.endsWith("workflow"),template=manifest.jobs.find(j=>j.id===(isWorkflow?"brand-collection-workflow":"brand-collection-control"))!;
    const runtime=await readGncPrivateJson(template.env.V3_WORKER_CONFIG!) as any;
    Object.assign(runtime,{role,hostId:`mini-${role}`,capability:"schedule.intake.workflow",compatibility:"schedule-v1",expectedBuildId:isWorkflow?workflow:activity});
    const folder=join(root!,role);await mkdir(folder,{mode:0o700});const path=join(folder,"runtime.json");await writeFile(path,JSON.stringify(runtime),{mode:0o600,flag:"wx"});
    manifest.jobs.push({id:role,entry:template.entry,env:{...template.env,V3_WORKER_CONFIG:path}});
  }
  await replace(join(root!,"deployment.json"),DeploymentSchema.parse(manifest));
  for(const job of manifest.jobs){
    const path=job.env.V3_BRAND_PIPELINE_CONFIG;if(!path)continue;
    const config=BrandPipelineConfig.parse(await readGncPrivateJson(path));
    config.policy.queues.acquireReceipts="v3.file.receipt.v1.acquisition-v1";await replace(path,config);
  }
  for(const job of manifest.jobs){
    const path=job.env.V3_WORKER_CONFIG;if(!path)continue;
    assert.ok(path.startsWith(root!+"/"));const runtime=await readGncPrivateJson(path) as any;
    runtime.expectedBuildId=job.entry.endsWith("/product-workflow-worker.js")?workflow:activity;
    await replace(path,runtime);
  }
  await writeFile(join(root!,`release-${randomUUID()}.json`),JSON.stringify({at:new Date().toISOString(),activity,workflow,files:files.length,unsubmitted:true}),{mode:0o600,flag:"wx"});
  console.log(JSON.stringify({event:"BATCH_A_RELEASE_SEALED",activity,workflow,workers:manifest.jobs.length}));
}finally{await db.end();}
