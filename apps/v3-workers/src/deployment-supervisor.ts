import { spawn, type ChildProcess } from "node:child_process";
import { open, mkdir, readFile, writeFile, unlink, statfs } from "node:fs/promises";
import { isAbsolute, join, resolve, relative } from "node:path";
import { hostname } from "node:os";
import { z } from "zod";
import pg from "pg";
import { readGncPrivateJson } from "./gnc-config.js";
import { DependencyMonitor, DependencyProbeSchema, runDependencyProbe } from "./dependency-probes.js";
import { readWorkerReady } from "./worker-readiness.js";

const path=z.string().refine(isAbsolute), token=z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const DeploymentSchema=z.strictObject({platform:z.literal("darwin"),host:z.string().min(1),root:path,node:path,
  startupIntervalMs:z.number().int().min(0).max(5000).optional(),
  jobs:z.array(z.strictObject({id:token,entry:path,env:z.record(z.string().regex(/^V3_[A-Z_]+$/),z.string())})).min(1).max(128),
  resources:z.array(z.strictObject({resourceId:token,capacity:z.number().int().min(1).max(64),jobs:z.array(token).min(1),minFreeBytes:z.number().int().nonnegative(),dependencies:z.array(token).max(20).optional()})).max(20),
  dependencyProbes:z.array(DependencyProbeSchema).max(20).optional(),
  database:z.strictObject({connectionString:z.string().min(1),tls:z.boolean()}),
}).refine(c=>new Set(c.jobs.map(j=>j.id)).size===c.jobs.length && new Set(c.resources.map(r=>r.resourceId)).size===c.resources.length &&
  c.resources.every(r=>r.jobs.every(id=>c.jobs.some(j=>j.id===id))) &&
  new Set(c.dependencyProbes?.map(p=>p.id)).size===(c.dependencyProbes?.length??0) &&
  c.resources.every(r=>(r.dependencies??[]).every(id=>c.dependencyProbes?.some(p=>p.id===id))));
export async function runDeployment(raw:unknown,signal:AbortSignal) {
  const c=DeploymentSchema.parse(raw);
  if(process.platform!==c.platform||hostname()!==c.host)throw Error("DEPLOYMENT.HOST_MISMATCH");
  await mkdir(c.root,{recursive:true,mode:0o700});
  const lockPath=join(c.root,"supervisor.lock");
  const lock=await open(lockPath,"wx",0o600);await lock.writeFile(JSON.stringify({pid:process.pid,host:c.host,at:new Date().toISOString()}));await lock.close();
  const jobs=new Map<string,{child:ChildProcess;health:string;log:string}>();
  const db=new pg.Pool({connectionString:c.database.connectionString,ssl:c.database.tls?{rejectUnauthorized:true}:false,max:2,connectionTimeoutMillis:5000,statement_timeout:5000});
  // Probe queries are read-only by construction; separate pool keeps dependency checks out of admission health writes.
  const probeDb=new pg.Pool({connectionString:c.database.connectionString,ssl:c.database.tls?{rejectUnauthorized:true}:false,max:2,connectionTimeoutMillis:3000,statement_timeout:3000,options:"-c default_transaction_read_only=on"});
  const monitor=new DependencyMonitor(c.dependencyProbes??[],runDependencyProbe,probeDb);
  let timer:NodeJS.Timeout|undefined,sampling:Promise<void>|undefined,safe=true,stopping=false;
  const controller=JSON.stringify([c.host,resolve(c.root)]);
  async function sample() {
    if(stopping)return;
      monitor.tick();
      const disk=await statfs(c.root);const states=new Map<string,boolean>();
      for(const [id,j] of jobs) {
        let ready=false;
        ready=await readWorkerReady(j.health,j.child.pid)&&j.child.exitCode===null&&j.child.signalCode===null;
        states.set(id,ready);
      }
      const dependencies=monitor.snapshot();
      for(const r of c.resources) {
        const localHealthy=r.jobs.every(id=>states.get(id))&&Number(disk.bavail)*Number(disk.bsize)>=r.minFreeBytes;
        const failed=(r.dependencies??[]).map(id=>dependencies.find(p=>p.id===id)).find(p=>!p?.healthy);
        const healthy=localHealthy&&!failed;
        await db.query("UPDATE resource_capacity SET healthy=$2,health_until=now()+interval '15 seconds',reason=$3 WHERE resource_id=$1 AND controller=$4",[r.resourceId,healthy&&!stopping,healthy?"ready":!localHealthy?"worker_or_disk_unhealthy":`${failed!.id}:${failed!.reason}`,controller]);
      }
      await writeFile(join(c.root,"status.json"),JSON.stringify({host:c.host,pid:process.pid,at:new Date().toISOString(),jobs:[...states].map(([id,ready])=>({id,ready})),dependencies}),{mode:0o600});
  }
  try {
    for(const r of c.resources) {
      await db.query("INSERT INTO resource_capacity(resource_id,capacity) VALUES($1,$2) ON CONFLICT DO NOTHING",[r.resourceId,r.capacity]);
      const owned=await db.query("UPDATE resource_capacity SET controller=$3 WHERE resource_id=$1 AND capacity=$2 AND (controller IS NULL OR controller=$3) RETURNING resource_id",[r.resourceId,r.capacity,controller]);
      if(owned.rowCount!==1)throw Error("DEPLOYMENT.RESOURCE_CONFIG_CONFLICT");
    }
    for(const job of c.jobs) {
      signal.throwIfAborted();const health=join(c.root,`${job.id}.health.json`),log=join(c.root,`${job.id}.log`);
      // Explicit root confines deployed entry points; private credential paths remain in env/config.
      if(relative(resolve(c.root),resolve(job.entry)).startsWith(".."))throw Error("DEPLOYMENT.ENTRY_OUTSIDE_ROOT");
      const file=await open(log,"a",0o600);
      const child=spawn(c.node,[job.entry],{env:{...process.env,...job.env,V3_WORKER_HEALTH_FILE:health},stdio:["ignore",file.fd,file.fd]});
      child.on("error",()=>{});await file.close();jobs.set(job.id,{child,health,log});
      if(c.startupIntervalMs)await new Promise(r=>setTimeout(r,c.startupIntervalMs));
    }
    const tick=()=>{if(!sampling)sampling=sample().catch(()=>{}).finally(()=>{sampling=undefined;});};
    tick();await sampling;
    timer=setInterval(tick,5000);
    await new Promise<void>(resolveStop=>{if(signal.aborted)resolveStop();else signal.addEventListener("abort",()=>resolveStop(),{once:true});});
  } finally {
    stopping=true;clearInterval(timer);await sampling;
    for(const r of c.resources)await db.query("UPDATE resource_capacity SET healthy=false,health_until=now(),reason='supervisor_stopping' WHERE resource_id=$1 AND controller=$2",[r.resourceId,controller]).catch(()=>{});
    for(const j of jobs.values())if(j.child.exitCode===null&&j.child.signalCode===null)j.child.kill("SIGTERM");
    const deadline=Date.now()+30000;
    while([...jobs.values()].some(j=>j.child.pid&&j.child.exitCode===null&&j.child.signalCode===null)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
    for(const j of jobs.values())if(j.child.pid&&j.child.exitCode===null&&j.child.signalCode===null){safe=false;j.child.kill("SIGKILL");}
    await monitor.close();await probeDb.end();await db.end();
    if(safe)await unlink(lockPath); // Only our exact lock, after all owned children have exited.
    else throw Error("DEPLOYMENT.STOP_UNVERIFIED");
  }
}
if(process.argv[1]?.endsWith("deployment-supervisor.js")) {
  const controller=new AbortController();process.once("SIGTERM",()=>controller.abort());process.once("SIGINT",()=>controller.abort());
  const config=process.argv[2];
  if(!config)throw Error("Private deployment manifest required");
  runDeployment(await readGncPrivateJson(config),controller.signal).catch(()=>{console.error(JSON.stringify({event:"DEPLOYMENT_FAILED",preserveEvidence:true}));process.exitCode=1;});
}
