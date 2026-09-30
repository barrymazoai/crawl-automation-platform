import fs from'node:fs/promises';import assert from'node:assert/strict';import{spawn}from'node:child_process';import{randomUUID}from'node:crypto';import{hostname}from'node:os';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const root='/Users/barry/apps/crawlv3-batch-a.UiA4dx',dir=root+'/live/swanson-coverage-deployment-20260910',read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const manifest=await read(dir+'/deployment.json'),ready=await read(dir+'/ready.json'),runDir=dir+'/preflight-'+randomUUID();await fs.mkdir(runDir,{mode:0o700});
const results=[];
for(const id of ready.jobs){
 const job=manifest.jobs.find(j=>j.id===id),runtime=await read(job.env.V3_WORKER_CONFIG),path=runDir+'/'+id,rt={...runtime,queueScope:'coverage-probe-'+randomUUID().slice(0,12)};
 await fs.writeFile(path+'.runtime.json',JSON.stringify(rt),{mode:0o600});const log=await fs.open(path+'.log','wx',0o600);
 const child=spawn(process.execPath,[job.entry],{env:{...process.env,...job.env,V3_WORKER_CONFIG:path+'.runtime.json',V3_WORKER_HEALTH_FILE:path+'.health.json'},stdio:['ignore',log.fd,log.fd]});await log.close();
 let running=false,normalExit=false;
 try{const until=Date.now()+90000;while(Date.now()<until&&child.exitCode===null&&child.signalCode===null){try{const h=await read(path+'.health.json');if(h.pid===child.pid&&h.event==='WORKER_RUNNING'){running=true;break;}}catch{}await new Promise(r=>setTimeout(r,200));}}
 finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await Promise.race([new Promise(r=>child.exitCode!==null||child.signalCode!==null?r():child.once('exit',r)),new Promise(r=>setTimeout(r,25000))]);normalExit=child.exitCode===0;}
 const row={role:id,ready:running,normalExit,pid:child.pid};results.push(row);await fs.writeFile(dir+'/evidence/preflight.json',JSON.stringify({passed:results.length===9&&results.every(r=>r.ready&&r.normalExit),results,businessCalls:0,runDir},null,2));console.log(JSON.stringify(row));assert.ok(running&&normalExit);
}
