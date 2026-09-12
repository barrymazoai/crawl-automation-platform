import{fork,type ChildProcess}from'node:child_process';import{open,readFile,readdir,writeFile,unlink,mkdir,statfs}from'node:fs/promises';import{dirname,isAbsolute,join}from'node:path';import{hostname}from'node:os';import{fileURLToPath}from'node:url';import{z}from'zod';import{randomUUID}from'node:crypto';
import{artifactBuildId,parseWorkerConfig,connectTemporal}from'@crawl-automation/v3-worker-runtime';import{LoopbackCdp}from'@crawl-automation/v3-acquisition';import{createR2Objects}from'@crawl-automation/v3-artifacts';import{DtcBrowserConfigSchema}from'./dtc-live-config.js';import{DtcLegacyCapture}from'./dtc-legacy-capture.js';import{readGncPrivateJson}from'./gnc-config.js';import{readWorkerReady}from'./worker-readiness.js';import{validateDtcSite}from'@crawl-automation/v3-channels';
import{DtcNodeSessionSchema}from'@crawl-automation/v3-contracts';
import{dtcTemporal}from'./dtc-temporal-control.js';
import{preflightDtcMini,openDtcSession,reportDtcSession,closeDtcSession}from'./dtc-node-session.js';
import{dtcNodeError,dtcNodeLogger}from'./dtc-node-log.js';
import{writeSync}from'node:fs';
const path=z.string().refine(isAbsolute);
export const DtcNodeSchema=z.strictObject({version:z.literal(1),platform:z.literal('win32'),host:z.string().min(1),root:path,privateConfig:path,runtimes:z.strictObject({capture:path,'catalog-source':path,file:path})});
export async function loadDtcNode(file:string){const node=DtcNodeSchema.parse(await readGncPrivateJson(file));if(process.platform!==node.platform||hostname()!==node.host)throw Error('DTC.NODE_HOST_MISMATCH');const config=DtcBrowserConfigSchema.parse(await readGncPrivateJson(node.privateConfig));validateDtcSite(config.site);return{node,config};}
export async function pendingDtcPages(root:string):Promise<string[]>{const out:string[]=[];async function walk(dir:string){let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}for(const e of entries){if(e.isSymbolicLink())throw Error('DTC.JOURNAL_SYMLINK');if(e.isDirectory())await walk(join(dir,e.name));else if(e.name==='intent.json'){try{await readFile(join(dir,'closed.json'));}catch(err){if((err as NodeJS.ErrnoException).code!=='ENOENT')throw err;out.push(JSON.parse(await readFile(join(dir,e.name),'utf8')).taskId);}}}}await walk(join(root,'v3','cdp-pages'));return out;}
export async function doctor(file:string){const {node,config}=await loadDtcNode(file);if(await readFile(join(node.root,"STOP")).then(()=>true,()=>false))throw Error("DTC.STOP_REQUEST_PRESENT");if(await readFile(join(node.root,'node-session.json')).then(()=>true,()=>false))throw Error('DTC.NODE_RECOVERY_REQUIRED');const release=dirname(fileURLToPath(import.meta.url));
 const buildId=await artifactBuildId((await readdir(release)).filter(n=>n.endsWith('.js')).sort().map(n=>join(release,n)));
 for(const [role,path]of Object.entries(node.runtimes)){const r=parseWorkerConfig(await readGncPrivateJson(path));if(r.role!==`dtc-${role}`||r.capability!==`dtc.${role}`||r.compatibility!=='dtc-live-v2'||r.expectedBuildId!==buildId||r.concurrency!==1)throw Error('DTC.RUNTIME_MISMATCH');const conn=await connectTemporal(r);await conn.close();}
 if((await pendingDtcPages(config.pageJournalRoot)).length)throw Error('DTC.PAGE_RECOVERY_REQUIRED');
 await new LoopbackCdp(config.browser).list(AbortSignal.timeout(10000));
 const codex=new DtcLegacyCapture(config.codex,process.env);try{await codex.check(AbortSignal.timeout(60000));}finally{await codex.close();}
 const temporal=await dtcTemporal(parseWorkerConfig(await readGncPrivateJson(node.runtimes.capture)));
 try{await preflightDtcMini(temporal,config);}finally{await temporal.connection.close();}
 const r2=createR2Objects(config.r2,config.r2Credentials);try{await r2.store.read('v3/dtc-doctor/read-only-probe.json',1024,AbortSignal.timeout(15000));}finally{r2.close();}
 return{node,config,release,buildId};
}
export async function runDtcNode(file:string,signal:AbortSignal){
 const {node,config,release}=await doctor(file);await mkdir(node.root,{recursive:true});
 const lockPath=join(node.root,'supervisor.lock'),lock=await open(lockPath,'wx',0o600);
 await lock.writeFile(JSON.stringify({pid:process.pid,host:hostname(),at:new Date().toISOString()}));await lock.close();
 const session=DtcNodeSessionSchema.parse({node:{nodeId:config.nodeControl.nodeId,host:node.host,root:node.root},sessionId:randomUUID(),controlQueue:config.nodeControl.activityQueue});
 const sessionPath=join(node.root,'node-session.json'),children:{role:string,child:ChildProcess,health:string}[]=[];
 let temporal:Awaited<ReturnType<typeof dtcTemporal>>|undefined,safe=true,created=false,requested=false,sequence=0,stage='session_create',stopReason='initialization',shutdownRequested=false;
 const eventLog=dtcNodeLogger(node.root),record=(event:string,fields:Record<string,unknown>={})=>eventLog({event,sessionId:session.sessionId,stage,...fields});
 const save=async(launchPending=false)=>writeFile(sessionPath,JSON.stringify({session,supervisorPid:process.pid,launchPending,workers:children.map(j=>({role:j.role,pid:j.child.pid??null}))}),{mode:0o600});
 try{
  // Durable identity precedes the remote request. Unknown ownership is preserved for explicit recovery.
  await writeFile(sessionPath,JSON.stringify({session,supervisorPid:process.pid,launchPending:false,workers:[]}),{flag:'wx',mode:0o600});created=true;
  stage='temporal_connect';temporal=await dtcTemporal(parseWorkerConfig(await readGncPrivateJson(node.runtimes.capture)));
  stage='session_open';requested=true;await openDtcSession(temporal,config,session);
  stage='initial_health';await reportDtcSession(temporal,session,sequence++,false,{signal,log:eventLog});
  for(const [role,runtime]of Object.entries(node.runtimes)){
   signal.throwIfAborted();const health=join(node.root,role+'.health.json'),log=await open(join(node.root,role+'.log'),'a',0o600);
   await save(true);
   stage='worker_start';
   try{const child=fork(join(release,'dtc-browser-worker.js'),[],{env:{...process.env,V3_WORKER_ENABLED:'true',V3_WORKER_CONFIG:runtime,V3_DTC_BROWSER_ENABLED:'true',V3_DTC_BROWSER_CONFIG:node.privateConfig,V3_WORKER_HEALTH_FILE:health},stdio:['ignore',log.fd,log.fd,'ipc']});
    child.on('error',error=>{void record('DTC_NODE_WORKER_ERROR',{role,workerPid:child.pid,shutdownRequested,error:dtcNodeError(error)});});
    child.on('exit',(exitCode,exitSignal)=>{void record('DTC_NODE_WORKER_EXIT',{role,workerPid:child.pid,exitCode,signal:exitSignal,shutdownRequested});});
    children.push({role,child,health});await save();await record('DTC_NODE_WORKER_STARTED',{role,workerPid:child.pid});
   }finally{await log.close();}
  }
  while(!signal.aborted){
   stage='health_observation';let browserReady=true;try{await new LoopbackCdp(config.browser).guard(AbortSignal.timeout(5000));}catch(error){browserReady=false;await record('DTC_NODE_BROWSER_GUARD_FAILED',{error:dtcNodeError(error)});}
   const disk=await statfs(node.root),states=await Promise.all(children.map(async j=>({role:j.role,pid:j.child.pid,ready:j.child.exitCode===null&&j.child.signalCode===null&&await readWorkerReady(j.health,j.child.pid)})));
   const healthy=browserReady&&states.every(s=>s.ready)&&Number(disk.bavail)*Number(disk.bsize)>1024**3;
   if(children.some(j=>j.child.exitCode!==null||j.child.signalCode!==null)){stage='worker_exit';throw Error('DTC.WORKER_STOPPED_INSPECT_REQUIRED');}
   if(!healthy)await record('DTC_NODE_UNHEALTHY_OBSERVATION',{browserReady,states,freeBytes:Number(disk.bavail)*Number(disk.bsize)});
   stage='health_update';await reportDtcSession(temporal,session,sequence++,healthy,{signal,log:eventLog});
   stage='status_write';
   await writeFile(join(node.root,'status.json'),JSON.stringify({pid:process.pid,at:new Date().toISOString(),healthy,sessionId:session.sessionId,nodeWorkflowId:'v3-dtc-node-'+session.node.nodeId,states}),{mode:0o600});
   if(children.some(j=>j.child.exitCode!==null||j.child.signalCode!==null))throw Error('DTC.WORKER_STOPPED_INSPECT_REQUIRED');
   if(await readFile(join(node.root,'STOP')).then(()=>true,()=>false)){stopReason='stop_file';break;}
   await new Promise<void>(r=>{const t=setTimeout(done,5000);function done(){clearTimeout(t);signal.removeEventListener('abort',done);r();}signal.addEventListener('abort',done,{once:true});});
  }
  if(signal.aborted)stopReason='signal';
 }catch(error){stopReason=signal.aborted?'signal':'error';await record('DTC_NODE_STOP_TRIGGER',{reason:stopReason,signal:signal.aborted?dtcNodeError(signal.reason):null,error:dtcNodeError(error)});throw error;
 }finally{
  await record('DTC_NODE_STOP_STARTED',{reason:stopReason,signal:signal.aborted?dtcNodeError(signal.reason):null});
  stage='shutdown_health';
  if(requested&&temporal)await reportDtcSession(temporal,session,sequence++,false,{log:eventLog}).catch(async error=>{safe=false;await record('DTC_NODE_SHUTDOWN_HEALTH_FAILED',{error:dtcNodeError(error)});});
  stage='worker_drain';shutdownRequested=true;
  for(const j of children)if(j.child.connected)try{j.child.send({type:'v3-stop'},error=>{if(error){safe=false;void record('DTC_NODE_WORKER_STOP_SEND_FAILED',{role:j.role,error:dtcNodeError(error)});}});}catch(error){safe=false;await record('DTC_NODE_WORKER_STOP_SEND_FAILED',{role:j.role,error:dtcNodeError(error)});}
  const until=Date.now()+125000;while(children.some(j=>j.child.pid&&j.child.exitCode===null&&j.child.signalCode===null)&&Date.now()<until)await new Promise(r=>setTimeout(r,200));
  if(children.some(j=>j.child.pid&&j.child.exitCode===null&&j.child.signalCode===null)){safe=false;await record('DTC_NODE_WORKER_DRAIN_UNCONFIRMED',{workers:children.map(j=>({role:j.role,pid:j.child.pid,exitCode:j.child.exitCode,signal:j.child.signalCode}))});}
  stage='session_close';
  if(safe&&requested&&temporal)await closeDtcSession(temporal,session).catch(async error=>{safe=false;await record('DTC_NODE_SESSION_CLOSE_FAILED',{error:dtcNodeError(error)});});
  await temporal?.connection.close();
  if(safe){await writeFile(join(node.root,'status.json'),JSON.stringify({pid:process.pid,at:new Date().toISOString(),healthy:false,status:'stopped',sessionId:session.sessionId}),{mode:0o600});if(created)await unlink(sessionPath).catch(e=>{if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;});await unlink(lockPath);await record('DTC_NODE_STOP_COMPLETED',{reason:stopReason});}
  else throw Error('DTC.STOP_UNVERIFIED_PRESERVE_LOCK');
 }
}
if(process.argv[1]?.endsWith("dtc-node.js")){const [command,file]=process.argv.slice(2);const c=new AbortController();process.once('SIGINT',()=>c.abort('SIGINT'));process.once('SIGTERM',()=>c.abort('SIGTERM'));
 process.once('exit',exitCode=>{try{writeSync(2,JSON.stringify({at:new Date().toISOString(),pid:process.pid,event:'DTC_NODE_PROCESS_EXIT',command,exitCode})+'\n');}catch{}});
 try{if(!file)throw Error();if(command==='doctor'){await doctor(file);console.log('DTC_DOCTOR_PASSED (Mini preflight only; no crawl submitted)');}else if(command==='start')await runDtcNode(file,c.signal);else if(command==='stop'){const{node}=await loadDtcNode(file);await writeFile(join(node.root,'STOP'),'stop\n',{flag:'wx',mode:0o600});console.log('DTC_STOP_REQUESTED; verify process exit and pending pages');}else throw Error();}catch(e){console.error(JSON.stringify({at:new Date().toISOString(),pid:process.pid,event:'DTC_NODE_COMMAND_FAILED',command,error:dtcNodeError(e)}));process.exitCode=1;}}
