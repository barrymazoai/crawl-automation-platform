import{fork,type ChildProcess}from'node:child_process';import{open,readFile,readdir,writeFile,unlink,mkdir,statfs}from'node:fs/promises';import{dirname,isAbsolute,join}from'node:path';import{hostname}from'node:os';import{fileURLToPath}from'node:url';import{z}from'zod';import pg from'pg';
import{artifactBuildId,parseWorkerConfig,connectTemporal}from'@crawl-automation/v3-worker-runtime';import{LoopbackCdp}from'@crawl-automation/v3-acquisition';import{createR2Objects}from'@crawl-automation/v3-artifacts';import{DtcLiveConfigSchema}from'./dtc-live-config.js';import{DtcCodexDecider}from'./dtc-codex.js';import{readGncPrivateJson}from'./gnc-config.js';import{readWorkerReady}from'./worker-readiness.js';import{validateDtcSite}from'@crawl-automation/v3-channels';
const path=z.string().refine(isAbsolute);
export const DtcNodeSchema=z.strictObject({version:z.literal(1),platform:z.literal('win32'),host:z.string().min(1),root:path,privateConfig:path,runtimes:z.strictObject({capture:path,'catalog-source':path,file:path})});
export async function loadDtcNode(file:string){const node=DtcNodeSchema.parse(await readGncPrivateJson(file));if(process.platform!==node.platform||hostname()!==node.host)throw Error('DTC.NODE_HOST_MISMATCH');const config=DtcLiveConfigSchema.parse(await readGncPrivateJson(node.privateConfig));validateDtcSite(config.site);return{node,config};}
export async function pendingDtcPages(root:string):Promise<string[]>{const out:string[]=[];async function walk(dir:string){let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}for(const e of entries){if(e.isSymbolicLink())throw Error('DTC.JOURNAL_SYMLINK');if(e.isDirectory())await walk(join(dir,e.name));else if(e.name==='intent.json'){try{await readFile(join(dir,'closed.json'));}catch(err){if((err as NodeJS.ErrnoException).code!=='ENOENT')throw err;out.push(JSON.parse(await readFile(join(dir,e.name),'utf8')).taskId);}}}}await walk(join(root,'v3','cdp-pages'));return out;}
export async function doctor(file:string){const {node,config}=await loadDtcNode(file);if(await readFile(join(node.root,"STOP")).then(()=>true,()=>false))throw Error("DTC.STOP_REQUEST_PRESENT");const release=dirname(fileURLToPath(import.meta.url));
 const buildId=await artifactBuildId((await readdir(release)).filter(n=>n.endsWith('.js')).sort().map(n=>join(release,n)));
 for(const [role,path]of Object.entries(node.runtimes)){const r=parseWorkerConfig(await readGncPrivateJson(path));if(r.role!==`dtc-${role}`||r.capability!==`dtc.${role}`||r.compatibility!=='dtc-live-v1'||r.expectedBuildId!==buildId||r.concurrency!==1)throw Error('DTC.RUNTIME_MISMATCH');const conn=await connectTemporal(r);await conn.close();}
 if((await pendingDtcPages(config.pageJournalRoot)).length)throw Error('DTC.PAGE_RECOVERY_REQUIRED');
 await new LoopbackCdp(config.browser).list(AbortSignal.timeout(10000));
 const codex=await DtcCodexDecider.open(config.codex,process.env);try{await codex.check(AbortSignal.timeout(60000));}finally{await codex.close();}
 const db=new pg.Pool({...(config.resourceDatabase??config.database),ssl:(config.resourceDatabase??config.database).tls?{rejectUnauthorized:true}:false,connectionTimeoutMillis:5000,statement_timeout:5000});
 try{const q=await db.query('SELECT resource_id FROM resource_capacity WHERE resource_id=$1',[config.browserModelResource]);if(q.rowCount!==1)throw Error('DTC.SHARED_MODEL_RESOURCE_MISSING');await db.query('SELECT permit_id FROM resource_permit LIMIT 0');}finally{await db.end();}
 const r2=createR2Objects(config.r2,config.r2Credentials);try{await r2.store.read('v3/dtc-doctor/read-only-probe.json',1024,AbortSignal.timeout(15000));}finally{r2.close();}
 return{node,config,release,buildId};
}
export async function runDtcNode(file:string,signal:AbortSignal){const {node,config,release}=await doctor(file);await mkdir(node.root,{recursive:true});const lockPath=join(node.root,'supervisor.lock'),lock=await open(lockPath,'wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid,host:hostname(),at:new Date().toISOString()}));await lock.close();
 const database=config.resourceDatabase??config.database,db=new pg.Pool({connectionString:database.connectionString,ssl:database.tls?{rejectUnauthorized:true}:false,connectionTimeoutMillis:5000,statement_timeout:5000});const children:{role:string,child:ChildProcess,health:string}[]=[],controller=JSON.stringify([node.host,node.root]);let safe=true;
 try{
  await db.query('INSERT INTO resource_capacity(resource_id,capacity) VALUES($1,1) ON CONFLICT DO NOTHING',[config.browserResource]);
  const owned=await db.query('UPDATE resource_capacity SET controller=$2,healthy=false,health_until=now() WHERE resource_id=$1 AND capacity=1 AND (controller IS NULL OR controller=$2) RETURNING resource_id',[config.browserResource,controller]);if(owned.rowCount!==1)throw Error('DTC.BROWSER_RESOURCE_CONFLICT');
  for(const [role,runtime]of Object.entries(node.runtimes)){signal.throwIfAborted();const health=join(node.root,role+'.health.json'),log=await open(join(node.root,role+'.log'),'a',0o600);const child=fork(join(release,'dtc-live-worker.js'),[],{env:{...process.env,V3_WORKER_ENABLED:'true',V3_WORKER_CONFIG:runtime,V3_DTC_LIVE_ENABLED:'true',V3_DTC_LIVE_CONFIG:node.privateConfig,V3_WORKER_HEALTH_FILE:health},stdio:['ignore',log.fd,log.fd,'ipc']});child.on('error',()=>{});await log.close();children.push({role,child,health});}
  while(!signal.aborted){
   let browserReady=true;try{await new LoopbackCdp(config.browser).guard(AbortSignal.timeout(5000));}catch{browserReady=false;}
   const disk=await statfs(node.root),states=await Promise.all(children.map(async j=>({role:j.role,pid:j.child.pid,ready:j.child.exitCode===null&&j.child.signalCode===null&&await readWorkerReady(j.health,j.child.pid)})));
   const healthy=browserReady&&states.every(s=>s.ready)&&Number(disk.bavail)*Number(disk.bsize)>1024**3;
   await db.query("UPDATE resource_capacity SET healthy=$2,health_until=now()+interval '15 seconds',reason=$3 WHERE resource_id=$1 AND controller=$4",[config.browserResource,healthy,healthy?'ready':'dtc_node_unready',controller]);
   await writeFile(join(node.root,'status.json'),JSON.stringify({pid:process.pid,at:new Date().toISOString(),healthy,states}),{mode:0o600});
   if(children.some(j=>j.child.exitCode!==null||j.child.signalCode!==null))throw Error('DTC.WORKER_STOPPED_INSPECT_REQUIRED');
   if(await readFile(join(node.root,'STOP')).then(()=>true,()=>false))break;
   await new Promise<void>(r=>{const t=setTimeout(done,2000);function done(){clearTimeout(t);signal.removeEventListener('abort',done);r();}signal.addEventListener('abort',done,{once:true});});
  }
 }finally{
  await db.query("UPDATE resource_capacity SET healthy=false,health_until=now(),reason='dtc_node_stopping' WHERE resource_id=$1 AND controller=$2",[config.browserResource,controller]).catch(()=>{safe=false;});
  for(const j of children)if(j.child.connected)j.child.send({type:'v3-stop'},error=>{if(error)safe=false;});
  const until=Date.now()+125000;while(children.some(j=>j.child.pid&&j.child.exitCode===null&&j.child.signalCode===null)&&Date.now()<until)await new Promise(r=>setTimeout(r,200));
  if(children.some(j=>j.child.pid&&j.child.exitCode===null&&j.child.signalCode===null))safe=false;
  await db.end();if(safe)await unlink(lockPath);else throw Error('DTC.STOP_UNVERIFIED_PRESERVE_LOCK');
 }
}
if(process.argv[1]?.endsWith("dtc-node.js")){const [command,file]=process.argv.slice(2);const c=new AbortController();process.once('SIGINT',()=>c.abort());process.once('SIGTERM',()=>c.abort());
 try{if(!file)throw Error();if(command==='doctor'){await doctor(file);console.log('DTC_DOCTOR_PASSED (no workflow submitted)');}else if(command==='start')await runDtcNode(file,c.signal);else if(command==='stop'){const{node}=await loadDtcNode(file);await writeFile(join(node.root,'STOP'),'stop\n',{flag:'wx',mode:0o600});console.log('DTC_STOP_REQUESTED; verify process exit and pending pages');}else throw Error();}catch(e){console.error(e instanceof Error&&/^DTC\.[A-Z_]+$/.test(e.message)?e.message:'DTC.NODE_COMMAND_FAILED');process.exitCode=1;}}
