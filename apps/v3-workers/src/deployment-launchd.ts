import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, open, unlink, rename, statfs } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { homedir, hostname } from "node:os";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { DeploymentSchema } from "./deployment-supervisor.js";
import { readGncPrivateJson } from "./gnc-config.js";
import { DependencyMonitor, runDependencyProbe } from "./dependency-probes.js";
import { readWorkerReady } from "./worker-readiness.js";

type Deployment = ReturnType<typeof DeploymentSchema.parse>;
type Job = Deployment["jobs"][number];
const execute = promisify(execFile);
const pause = (ms:number) => new Promise<void>(done => setTimeout(done, ms));
const domain = () => `gui/${process.getuid!()}`;
const xml = (s:string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export function serviceLabel(c:Pick<Deployment,"host"|"root">, id?:string) {
  const scope=createHash("sha256").update(JSON.stringify([c.host,resolve(c.root)])).digest("hex").slice(0,16);
  return id ? `com.crawlv3.w.${scope}.${id}` : `com.crawlv3.m.${scope}`;
}
export function parseLaunchdList(text:string) {
  const found=new Map<string,number|undefined>();
  for(const line of text.split("\n")) {
    const match=/^\s*(\d+|-)\s+(-?\d+)\s+(\S+)\s*$/.exec(line);
    if(match)found.set(match[3]!,match[1]==="-"?undefined:Number(match[1]));
  }
  return found;
}
export function renderService(c:Deployment, manifest:string, controlEntry:string, job?:Job) {
  const label=serviceLabel(c,job?.id), log=join(c.root,job?`${job.id}.log`:"independent-monitor.log");
  const args=job?[c.node,job.entry]:[c.node,controlEntry,"monitor",manifest];
  const searchPath=[...new Set(["/opt/homebrew/bin",...(process.env.PATH??"").split(":").filter(Boolean),"/usr/bin","/bin","/usr/sbin","/sbin"])].join(":");
  const env={PATH:searchPath,...(job?job.env:{}),
    ...(job?{V3_WORKER_HEALTH_FILE:join(c.root,`${job.id}.health.json`)}:{})};
  // Crash restart: a service that exits non-zero is started again by launchd (2026-09-17: a monitor killed by one
  // dropped database connection stayed down for 10 hours and idled the fleet). A clean exit stays stopped, so
  // operator stops and drains still hold, and the throttle keeps a rejected start from looping hot.
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(label)}</string>\n<key>ProgramArguments</key><array>${args.map(a=>`<string>${xml(a)}</string>`).join("")}</array>\n<key>WorkingDirectory</key><string>${xml(c.root)}</string>\n<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k,v])=>`<key>${xml(k)}</key><string>${xml(v)}</string>`).join("")}</dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>30</integer>\n<key>ExitTimeOut</key><integer>150</integer>\n<key>StandardOutPath</key><string>${xml(log)}</string>\n<key>StandardErrorPath</key><string>${xml(log)}</string>\n</dict></plist>\n`;
}
async function launchctl(...args:string[]) { return (await execute("/bin/launchctl",args,{timeout:170000,maxBuffer:4*1024*1024})).stdout; }
async function services() { return parseLaunchdList(await launchctl("list")); }
async function load(manifest:string) {
  const c=DeploymentSchema.parse(await readGncPrivateJson(manifest));
  if(process.platform!=="darwin"||c.host!==hostname())throw Error("DEPLOYMENT.HOST_MISMATCH");
  for(const j of c.jobs)if(relative(resolve(c.root),resolve(j.entry)).startsWith(".."))throw Error("DEPLOYMENT.ENTRY_OUTSIDE_ROOT");
  return c;
}
async function json(path:string,value:unknown) {
  const temp=`${path}.${process.pid}.tmp`;
  await writeFile(temp,JSON.stringify(value),{mode:0o600});await rename(temp,path);
}
function invariant(c:Deployment) { const {jobs:_jobs,startupIntervalMs:_interval,...fixed}=c;return JSON.stringify({...fixed,jobIds:c.jobs.map(j=>j.id)}); }
export async function independentReady(c:Deployment,j:Job,pid:number|undefined) {
  if(!pid||!await readWorkerReady(join(c.root,`${j.id}.health.json`),pid))return false;
  try {
    process.kill(pid,0);
    if(j.env.V3_WORKER_CONFIG) {
      const runtime=await readGncPrivateJson(j.env.V3_WORKER_CONFIG) as {role:string;expectedBuildId:string};
      const h=JSON.parse(await readFile(join(c.root,`${j.id}.health.json`),"utf8"));
      if(h.pid!==pid||h.role!==runtime.role||h.buildId!==runtime.expectedBuildId)return false;
    }
    return true;
  }catch{return false;}
}
export async function runIndependentMonitor(manifest:string,signal:AbortSignal) {
  const c=await load(manifest),controller=JSON.stringify([c.host,resolve(c.root)]),lockPath=join(c.root,"supervisor.lock");
  // A monitor that died leaves its lock behind. Refusing to start then keeps every resource's health expired and the
  // whole fleet idle (2026-09-17: 10 hours, 2,745 products). Take over a lock whose process is gone; never one that lives.
  const lock=await (async()=>{
    for(let attempt=0;;attempt++){
      try{return await open(lockPath,"wx",0o600);}
      catch(error){
        if((error as NodeJS.ErrnoException).code!=="EEXIST"||attempt)throw error;
        const held=JSON.parse(await readFile(lockPath,"utf8")) as {pid?:unknown;host?:unknown;kind?:unknown};
        if(held.kind!=="independent-monitor"||held.host!==c.host||typeof held.pid!=="number")throw error;
        try{process.kill(held.pid,0);throw Error("DEPLOYMENT.MONITOR_ALREADY_RUNNING");}
        catch(e){if((e as NodeJS.ErrnoException).code!=="ESRCH")throw e;}
        console.log(JSON.stringify({event:"MONITOR_LOCK_TAKEOVER",deadPid:held.pid}));
        return await open(lockPath,"w",0o600);
      }
    }
  })();
  await lock.writeFile(JSON.stringify({pid:process.pid,host:c.host,kind:"independent-monitor",at:new Date().toISOString()}));await lock.close();
  const db=new pg.Pool({connectionString:c.database.connectionString,ssl:c.database.tls?{rejectUnauthorized:true}:false,max:2,connectionTimeoutMillis:5000,statement_timeout:5000});db.on("error",e=>console.error(JSON.stringify({event:"DB_POOL_ERROR",scope:"monitor",message:String(e?.message).slice(0,160)})));
  const probeDb=new pg.Pool({connectionString:c.database.connectionString,ssl:c.database.tls?{rejectUnauthorized:true}:false,max:2,connectionTimeoutMillis:3000,statement_timeout:3000,options:"-c default_transaction_read_only=on"});probeDb.on("error",e=>console.error(JSON.stringify({event:"DB_POOL_ERROR",scope:"probe",message:String(e?.message).slice(0,160)})));
  const monitor=new DependencyMonitor(c.dependencyProbes??[],runDependencyProbe,probeDb);
  try {
    for(const r of c.resources) {
      await db.query("INSERT INTO resource_capacity(resource_id,capacity) VALUES($1,$2) ON CONFLICT DO NOTHING",[r.resourceId,r.capacity]);
      const owned=await db.query("UPDATE resource_capacity SET controller=$3 WHERE resource_id=$1 AND capacity=$2 AND (controller IS NULL OR controller=$3) RETURNING resource_id",[r.resourceId,r.capacity,controller]);
      if(owned.rowCount!==1)throw Error("DEPLOYMENT.RESOURCE_CONFIG_CONFLICT");
    }
    while(!signal.aborted) {
      // Re-read per-job entry/runtime bindings so replacing one Worker needs no monitor restart.
      const current=await load(manifest);if(invariant(current)!==invariant(c))throw Error("DEPLOYMENT.MONITOR_TOPOLOGY_CHANGED");
      monitor.tick();const loaded=await services(),disk=await statfs(c.root);
      const states:Array<{id:string;label:string;pid:number|null;ready:boolean}>=[];
      for(const j of current.jobs) {
        const label=serviceLabel(c,j.id),pid=loaded.get(label);
        states.push({id:j.id,label,pid:pid??null,ready:await independentReady(current,j,pid)});
      }
      const dependencies=monitor.snapshot();
      for(const r of c.resources) {
        const local=r.jobs.every(id=>states.some(s=>s.id===id&&s.ready))&&Number(disk.bavail)*Number(disk.bsize)>=r.minFreeBytes;
        const failed=(r.dependencies??[]).map(id=>dependencies.find(p=>p.id===id)).find(p=>!p?.healthy);
        const healthy=local&&!failed;
        await db.query("UPDATE resource_capacity SET healthy=$2,health_until=now()+interval '15 seconds',reason=$3 WHERE resource_id=$1 AND controller=$4",[r.resourceId,healthy&&!signal.aborted,healthy?"ready":!local?"worker_or_disk_unhealthy":`${failed!.id}:${failed!.reason}`,controller]);
      }
      await json(join(c.root,"status.json"),{host:c.host,pid:process.pid,at:new Date().toISOString(),mode:"independent",jobs:states,dependencies});
      await new Promise<void>(done=>{const finish=()=>{clearTimeout(timer);signal.removeEventListener("abort",finish);done();};const timer=setTimeout(finish,5000);signal.addEventListener("abort",finish,{once:true});if(signal.aborted)finish();});
    }
  }finally {
    // This process only owns monitoring. Never signal any independently managed Worker.
    for(const r of c.resources)await db.query("UPDATE resource_capacity SET healthy=false,health_until=now(),reason='monitor_stopping' WHERE resource_id=$1 AND controller=$2",[r.resourceId,controller]).catch(()=>{});
    await monitor.close();await probeDb.end();await db.end();
    await json(join(c.root,"status.json"),{host:c.host,pid:process.pid,at:new Date().toISOString(),mode:"independent",status:"monitor-stopped",jobs:c.jobs.map(j=>({id:j.id,ready:false}))});
    const owner=JSON.parse(await readFile(lockPath,"utf8"));if(owner.pid===process.pid&&owner.kind==="independent-monitor")await unlink(lockPath);
  }
}
async function assertNoLegacySupervisor(c:Deployment) {
  try {
    const lock=JSON.parse(await readFile(join(c.root,"supervisor.lock"),"utf8"));
    if(lock.kind!=="independent-monitor")throw Error("DEPLOYMENT.LEGACY_SUPERVISOR_STILL_OWNS_GROUP");
  }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
}
async function install(c:Deployment,manifest:string,entry:string,job?:Job) {
  const directory=join(homedir(),"Library","LaunchAgents");await mkdir(directory,{recursive:true});
  const path=join(directory,serviceLabel(c,job?.id)+".plist"),temp=path+`.${process.pid}.tmp`;
  await writeFile(temp,renderService(c,manifest,entry,job),{mode:0o600});
  await execute("/usr/bin/plutil",["-lint",temp]);await rename(temp,path);return path;
}
async function startService(c:Deployment,manifest:string,entry:string,job?:Job) {
  await assertNoLegacySupervisor(c);const label=serviceLabel(c,job?.id),loaded=await services();
  if(!loaded.has(label)) {
    const path=await install(c,manifest,entry,job);await launchctl("enable",`${domain()}/${label}`);await launchctl("bootstrap",domain(),path);
  }else if(!loaded.get(label))throw Error(`DEPLOYMENT.SERVICE_EXITED_RESTART_REQUIRED:${job?.id??"monitor"}`);
}
async function stopService(c:Deployment,job?:Job) {
  const label=serviceLabel(c,job?.id),loaded=await services();
  await launchctl("disable",`${domain()}/${label}`);if(!loaded.has(label))return;
  const pid=loaded.get(label);await launchctl("bootout",`${domain()}/${label}`);
  const deadline=Date.now()+150000;
  while(pid&&Date.now()<deadline) {try{process.kill(pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")return;throw error;}await pause(100);}
  if(pid)throw Error(`DEPLOYMENT.STOP_UNVERIFIED:${job?.id??"monitor"}`);
}
async function waitReady(c:Deployment,job:Job) {
  const runtime=job.env.V3_WORKER_CONFIG?await readGncPrivateJson(job.env.V3_WORKER_CONFIG) as {startupTimeoutMs?:number}:{};
  const began=Date.now(),deadline=began+(runtime.startupTimeoutMs??30000)+15000;
  while(Date.now()<deadline) {
    const loaded=await services(),pid=loaded.get(serviceLabel(c,job.id));
    if(await independentReady(c,job,pid))return pid;
    if(!pid&&Date.now()-began>1500)throw Error(`DEPLOYMENT.WORKER_EXITED:${job.id}`);
    await pause(250);
  }
  throw Error(`DEPLOYMENT.WORKER_NOT_READY:${job.id}`);
}
export async function runControl(command:string,manifest:string,id?:string) {
  const c=await load(manifest),entry=fileURLToPath(import.meta.url);
  const selected=id&&id!=="all"?c.jobs.filter(j=>j.id===id):c.jobs;
  if(!selected.length)throw Error("DEPLOYMENT.JOB_NOT_FOUND");
  if(command==="prepare") {
    const directory=join(c.root,"independent-services");await mkdir(directory,{recursive:true,mode:0o700});
    for(const j of [undefined,...c.jobs]) {const path=join(directory,serviceLabel(c,j?.id)+".plist");await writeFile(path,renderService(c,manifest,entry,j),{mode:0o600});await execute("/usr/bin/plutil",["-lint",path]);}
    return {prepared:c.jobs.length,installed:false,directory};
  }
  if(command==="status") {
    const loaded=await services(),jobs=[];
    for(const j of selected){const label=serviceLabel(c,j.id),pid=loaded.get(label);jobs.push({id:j.id,label,pid:pid??null,ready:await independentReady(c,j,pid)});}
    return {mode:"independent",monitorPid:loaded.get(serviceLabel(c))??null,jobs};
  }
  if(!["start","stop","restart"].includes(command)||!id)throw Error("DEPLOYMENT.EXPLICIT_COMMAND_AND_JOB_REQUIRED");
  await assertNoLegacySupervisor(c);
  if(command==="stop") {for(const j of [...selected].reverse())await stopService(c,j);if(id==="all")await stopService(c);return {stopped:selected.map(j=>j.id)};}
  if(command==="restart")for(const j of selected)await stopService(c,j);
  await startService(c,manifest,entry);
  for(const j of selected) {await startService(c,manifest,entry,j);if(c.startupIntervalMs)await pause(c.startupIntervalMs);}
  const ready=[];for(const j of selected)ready.push({id:j.id,pid:await waitReady(c,j)});
  return {ready};
}
if(process.argv[1]?.endsWith("deployment-launchd.js")) {
  const [command,manifest,id]=process.argv.slice(2);
  const controller=new AbortController();process.once("SIGTERM",()=>controller.abort());process.once("SIGINT",()=>controller.abort());
  const run=async()=>{if(!command||!manifest)throw Error("DEPLOYMENT.COMMAND_REQUIRED");if(command==="monitor")await runIndependentMonitor(manifest,controller.signal);else console.log(JSON.stringify(await runControl(command,manifest,id)));};
  run().catch(error=>{console.error(JSON.stringify({event:"INDEPENDENT_DEPLOYMENT_FAILED",code:error instanceof Error&&error.message.startsWith("DEPLOYMENT.")?error.message:"DEPLOYMENT.UNEXPECTED_ERROR",errorType:error?.name,errorCode:error?.code}));process.exitCode=1;});
}
