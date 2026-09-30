import assert from "node:assert/strict";
import { randomUUID,createHash } from "node:crypto";
import { mkdir,readFile,writeFile,rename } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname,join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { PostgresResourceAdmission } from "../../../packages/v3-product/src/resource-admission.js";
import { parseGncCatalog } from "../../../packages/v3-channels/src/gnc.js";
import { runDeployment } from "../src/deployment-supervisor.js";
import { migrationNames,migrate } from "../../v3-api/src/bootstrap/schema.js";
const [flag,root]=process.argv.slice(2);
assert.equal(flag,"--isolated-acceptance");assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
assert.match(root!,/^\/Users\/barry\/apps\/crawlv3-batch-a\.[A-Za-z0-9]+\/resource-proof$/);
const dist=dirname(fileURLToPath(import.meta.url)),exec=promisify(execFile),id=randomUUID(),container=`crawlv3-resource-${id.slice(0,8)}`;
const checks:string[]=[];let db:pg.Pool|undefined,owned=false;
const check=async(name:string,fn:()=>Promise<void>)=>{await fn();checks.push(name);console.log(JSON.stringify({check:name,passed:true}));};
async function until(fn:()=>Promise<boolean>,ms=30000){const end=Date.now()+ms;while(!await fn()){if(Date.now()>end)throw Error("WAIT_TIMEOUT");await new Promise(r=>setTimeout(r,100));}}
try {
  await mkdir(root!,{mode:0o700});const password=randomUUID();await writeFile(join(root!,"postgres.env"),`POSTGRES_USER=v3_admin\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=crawler_v3_test\n`,{mode:0o600,flag:"wx"});
  await mkdir(join(root!,"postgres-data"),{mode:0o700});
  await exec("docker",["run","-d","--name",container,"--label",`crawlv3.resource-proof=${id}`,"--publish","127.0.0.1::5432","--env-file",join(root!,"postgres.env"),"--mount",`type=bind,src=${join(root!,"postgres-data")},dst=/var/lib/postgresql`,"postgres:18"],{timeout:30000});owned=true;
  const port=Number((await exec("docker",["port",container,"5432/tcp"])).stdout.trim().split(":").at(-1));assert.ok(port>0);
  const connectionString=`postgresql://v3_admin:${password}@127.0.0.1:${port}/crawler_v3_test`;
  db=new pg.Pool({connectionString,max:12,connectionTimeoutMillis:2000,statement_timeout:10000});
  await until(async()=>{try{await db!.query("SELECT 1");return true;}catch{return false;}});
  const migrations=await Promise.all(migrationNames.map(async name=>{const sql=await readFile(join(dist,"migrations",name),"utf8");return{name,sql,sha256:createHash("sha256").update(sql).digest("hex")};}));
  await check("15 migrations on fresh isolated database",async()=>{const c=await db!.connect();try{await migrate(c,migrations);}finally{c.release();}assert.equal(migrations.length,15);});
  const admission=new PostgresResourceAdmission(db),request=(needs:{resourceId:string;units:number}[],permitId=`permit-${randomUUID()}`)=>({permitId,workflowId:"proof-product",runId:randomUUID(),needs});
  const ready=async(resource:string,capacity:number)=>db!.query("INSERT INTO resource_capacity(resource_id,capacity,healthy,health_until) VALUES($1,$2,true,now()+interval '1 hour')",[resource,capacity]);
  await check("40 concurrent requests never exceed shared capacity",async()=>{
    await ready("cpu",3);const requests=Array.from({length:40},()=>request([{resourceId:"cpu",units:1}]));
    const outcomes=await Promise.all(requests.map(r=>admission.reserve(r)));assert.equal(outcomes.filter(x=>x.status==="granted").length,3);
    for(let i=0;i<requests.length;i++)if(outcomes[i]!.status==="granted")await admission.release(requests[i]);
  });
  await check("lost admission/release acknowledgements replay identical intent",async()=>{
    const r=request([{resourceId:"cpu",units:2}]);const one=await admission.reserve(r);assert.deepEqual(await admission.reserve(r),one);
    await assert.rejects(admission.reserve({...r,needs:[{resourceId:"cpu",units:1}]}),/IDENTITY_CONFLICT/);
    const released=await admission.release(r);assert.deepEqual(await admission.release(r),released);assert.equal((await admission.reserve(r)).status,"released");
  });
  await check("multi-resource acquisition is atomic; no partial hold",async()=>{
    await ready("browser",1);await ready("model",1);const held=request([{resourceId:"model",units:1}]);await admission.reserve(held);
    const blocked=request([{resourceId:"browser",units:1},{resourceId:"model",units:1}]);assert.equal((await admission.reserve(blocked)).status,"waiting");
    const free=request([{resourceId:"browser",units:1}]);assert.equal((await admission.reserve(free)).status,"granted");await admission.release(free);await admission.release(held);
    assert.equal((await admission.reserve(blocked)).status,"granted");await admission.release(blocked);
  });
  await check("expired health blocks new work but never steals held permits",async()=>{
    const held=request([{resourceId:"cpu",units:3}]);await admission.reserve(held);
    await db!.query("UPDATE resource_capacity SET health_until=now()-interval '1 second' WHERE resource_id='cpu'");
    assert.equal((await admission.reserve(request([{resourceId:"cpu",units:1}]))).reason,"unhealthy");assert.equal((await admission.reserve(held)).status,"granted");
    assert.equal((await db!.query("SELECT released_at FROM resource_permit WHERE permit_id=$1",[held.permitId])).rows[0].released_at,null);await admission.release(held);
  });
  await check("independent remote resource is not constrained by Mini CPU health",async()=>{
    await ready("windows-ocr",4);const r=request([{resourceId:"windows-ocr",units:4}]);assert.equal((await admission.reserve(r)).status,"granted");await admission.release(r);
  });
  await check("invalid or over-capacity request is rejected, not left waiting forever",async()=>{
    await assert.rejects(admission.reserve(request([{resourceId:"missing",units:1}])) ,/NOT_CONFIGURED/);
    await assert.rejects(admission.reserve(request([{resourceId:"cpu",units:4}])),/NOT_CONFIGURED/);
  });
  await check("actual saved FocusFuel HTML has matching explicit single-page proof",async()=>{
    const html=await readFile("/tmp/crawlv3-focus-fuel-catalog.html","utf8"),page=parseGncCatalog(html,"https://www.gnc.com/brands/focus-fuel/");
    assert.deepEqual(page.countProof,{codec:"gnc-single-page-count/1",count:1});assert.equal(page.entries[0]!.sku,"613701");
  });
  await check("supervisor starts separate process, reports health, drains and restarts same deployment",async()=>{
    const config={platform:"darwin",host:hostname(),root:dirname(dist),node:process.execPath,jobs:[{id:"health-proof",entry:join(dist,"health-proof-worker.js"),env:{V3_SUPERVISOR_TEST:"true"}}],resources:[{resourceId:"supervised-cpu",capacity:1,jobs:["health-proof"],minFreeBytes:0}],database:{connectionString,tls:false}};
    for(let cycle=0;cycle<2;cycle++){
      const stop=new AbortController();let failure:unknown;
      const running=runDeployment(config,stop.signal).catch(e=>{failure=e;});
      try {await until(async()=>{if(failure)throw failure;return(await db!.query("SELECT healthy AND health_until>now() AS ready FROM resource_capacity WHERE resource_id='supervised-cpu'")).rows[0]?.ready===true;});
        const status=JSON.parse(await readFile(join(config.root,"status.json"),"utf8"));assert.equal(status.jobs[0].ready,true);
        await assert.rejects(runDeployment(config,new AbortController().signal),/EEXIST/);
      } finally {stop.abort();await running;}
      if(failure)throw failure;assert.equal((await db!.query("SELECT healthy FROM resource_capacity WHERE resource_id='supervised-cpu'")).rows[0].healthy,false);
    }
  });
  await check("periodic remote health and handoff backlog gate only new reservations, preserving held permits",async()=>{
    let available=true;
    const server=createServer((_q,r)=>r.end(JSON.stringify({status:"ok",healthy_backends:available?4:0,total_backends:4})));
    await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
    const journal=join(root!,"backlog-fixture");await mkdir(journal,{mode:0o700});
    const config={platform:"darwin",host:hostname(),root:dirname(dist),node:process.execPath,jobs:[{id:"health-proof",entry:join(dist,"health-proof-worker.js"),env:{V3_SUPERVISOR_TEST:"true"}}],
      dependencyProbes:[{id:"ocr-health",kind:"ocr-health",url:`http://127.0.0.1:${(server.address() as any).port}/health`,minHealthyBackends:2},
        {id:"pending-handoff",kind:"handoff-backlog",roots:[{root:journal,layout:"ocr"}],maxPending:1,maxOldestSeconds:60,maxFiles:100}],
      resources:[{resourceId:"supervised-remote",capacity:2,jobs:["health-proof"],minFreeBytes:0,dependencies:["ocr-health","pending-handoff"]},
        {resourceId:"independent-resource",capacity:1,jobs:["health-proof"],minFreeBytes:0}],database:{connectionString,tls:false}};
    const stop=new AbortController();let failure:unknown;const running=runDeployment(config,stop.signal).catch(e=>{failure=e;});
    const state=async(id:string)=>(await db!.query("SELECT healthy,reason FROM resource_capacity WHERE resource_id=$1",[id])).rows[0];
    const waitState=async(expected:boolean,reason?:string)=>until(async()=>{if(failure)throw failure;const s=await state("supervised-remote");return s?.healthy===expected&&(!reason||s.reason.includes(reason));},45000);
    try {
      await waitState(true);
      const held=request([{resourceId:"supervised-remote",units:1}]);assert.equal((await admission.reserve(held)).status,"granted");
      available=false;await waitState(false,"ocr");
      assert.equal((await admission.reserve(request([{resourceId:"supervised-remote",units:1}]))).reason,"unhealthy");
      assert.equal((await admission.reserve(held)).status,"granted");assert.equal((await state("independent-resource")).healthy,true);
      available=true;await waitState(true);
      const marker=join(journal,"pending-test.json");await writeFile(marker,"{}",{mode:0o600,flag:"wx"});await waitState(false,"handoff");
      assert.equal((await admission.reserve(held)).status,"granted");
      // This is a synthetic marker in our isolated fixture, not a business artifact. Retain it outside the scan.
      await rename(marker,join(root!,"retained-pending-test.json"));await waitState(true);
      await admission.release(held);
      const status=JSON.parse(await readFile(join(config.root,"status.json"),"utf8"));
      assert.equal(status.dependencies.length,2);assert.ok(status.dependencies.every((p:any)=>p.healthy));
    } finally {stop.abort();await running;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
    if(failure)throw failure;
  });
  await writeFile(join(root!,"report.json"),JSON.stringify({id,container,checks,passed:true,liveProviderCalls:0,scope:"resource SQL and supervisor fixture; not a real Brand workflow"},null,2),{mode:0o600,flag:"wx"});
} finally {await db?.end();if(owned)await exec("docker",["stop",container],{timeout:30000});}
