/** Bounded independent processes on empty queues; never calls a business Activity. */
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {randomUUID} from 'node:crypto';import {hostname} from 'node:os';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);const dir=process.argv[2];assert.match(dir??'',/^\/Users\/barry\/apps\/crawlv3-batch-a\.UiA4dx\/live\/channel-resident-20260910(?:-v[2-9])?$/);
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),manifest=await read(dir+'/deployment.json'),ready=await read(dir+'/ready.json');
if(process.argv[3]==='--verify-recorded'){
 const report=await read(dir+'/evidence/role-preflight.json'),jobs=manifest.jobs.filter(j=>j.env.V3_CHANNEL_LABEL_CONFIG);
 assert.equal(report.results.length,20);assert.equal(jobs.length,17);
 for(const job of jobs){const role=job.id.replace('channel-label-','');for(const mode of ['valid',...(['text','vision','ocr'].includes(role)?['missing-required']:[])]){
  const result=report.results.filter(r=>r.role===role&&r.mode===mode);assert.equal(result.length,1);assert.equal(result[0].passed,true);assert.equal(result[0].forced,false);
  const runtime=await read(report.runDir+'/'+job.id+'-'+mode+'.runtime.json');assert.equal(runtime.expectedBuildId,ready.activityBuild);assert.equal(runtime.role,job.id);
  const current=await read(job.env.V3_CHANNEL_LABEL_CONFIG),actual=await read(report.runDir+'/'+job.id+'-'+mode+'.private.json');current.root=actual.root;if(mode==='missing-required'){delete current.codex;delete current.ocrProvider;}assert.deepEqual(actual,current);
  if(mode==='valid'){assert.equal(result[0].ready,true);assert.equal(result[0].stopped,true);assert.equal(result[0].exitCode,0);assert.equal(result[0].prepared.hostId,runtime.hostId);}
 }}
 report.verifiedAt=new Date().toISOString();report.passed=true;report.harnessCorrection='Select Activity jobs by V3_CHANNEL_LABEL_CONFIG; completed 20 records reverified without repeating execution.';
 await fs.writeFile(dir+'/evidence/role-preflight.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,independentRoles:17,requiredConfigRejections:3,recordedProofVerified:true}));process.exit(0);
}
const runDir=dir+'/preflight-'+randomUUID();await fs.mkdir(runDir,{mode:0o700});
const results=[];
for(const job of manifest.jobs.filter(j=>j.env.V3_CHANNEL_LABEL_CONFIG)){
 const runtime=await read(job.env.V3_WORKER_CONFIG),c=await read(job.env.V3_CHANNEL_LABEL_CONFIG),role=job.id.replace('channel-label-','');
 assert.equal(Boolean(c.codex),['text','vision'].includes(role));assert.equal(Boolean(c.ocrProvider),role==='ocr');
 const modes=['valid',...(['text','vision','ocr'].includes(role)?['missing-required']:[])];
 for(const mode of modes){
 const name=job.id+'-'+mode,config=structuredClone(c);config.root=runDir+'/'+name;
 if(mode==='missing-required'){delete config.codex;delete config.ocrProvider;}
 const rt={...runtime,hostId:'probe-'+role,queueScope:'probe-'+randomUUID().slice(0,12),startupTimeoutMs:90000};
 const privateFile=runDir+'/'+name+'.private.json',runtimeFile=runDir+'/'+name+'.runtime.json',health=runDir+'/'+name+'.health.json',logFile=runDir+'/'+name+'.log';
 await fs.writeFile(privateFile,JSON.stringify(config),{mode:0o600});await fs.writeFile(runtimeFile,JSON.stringify(rt),{mode:0o600});
 const log=await fs.open(logFile,'wx',0o600);const child=spawn(process.execPath,[job.entry],{env:{...process.env,...job.env,V3_CHANNEL_LABEL_CONFIG:privateFile,V3_WORKER_CONFIG:runtimeFile,V3_WORKER_HEALTH_FILE:health},stdio:['ignore',log.fd,log.fd]});await log.close();
 let live=false,forced=false;
 try{const until=Date.now()+95000;while(Date.now()<until&&child.exitCode===null&&child.signalCode===null){try{const h=await read(health);if(h.pid===child.pid&&h.event==='WORKER_RUNNING'){live=true;break;}}catch{}await new Promise(r=>setTimeout(r,200));}}
 finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');const until=Date.now()+25000;while(child.exitCode===null&&child.signalCode===null&&Date.now()<until)await new Promise(r=>setTimeout(r,100));if(child.exitCode===null&&child.signalCode===null){forced=true;child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));}}
 const prepared=(await fs.readFile(logFile,'utf8')).split('\n').filter(l=>l.startsWith('{')).map(l=>{try{return JSON.parse(l);}catch{return null;}}).find(x=>x?.event==='CHANNEL_ROLE_PREPARED');
 let stopped=false;try{stopped=(await read(health)).event==='WORKER_STOPPED';}catch{}
 const passed=mode==='valid'?live&&stopped&&child.exitCode===0&&!forced:!live&&child.exitCode!==0&&!forced;
 results.push({role,mode,pid:child.pid,ready:live,stopped,exitCode:child.exitCode,forced,passed,prepared});
 await fs.writeFile(dir+'/evidence/role-preflight.json',JSON.stringify({at:new Date().toISOString(),runDir,results,workflowSubmissions:0,modelTurns:0},null,2));console.log(JSON.stringify(results.at(-1)));assert.ok(passed,'Independent role preflight failed');
 }
}
assert.equal(results.length,20);console.log(JSON.stringify({passed:true,independentRoles:17,requiredConfigRejections:3,report:dir+'/evidence/role-preflight.json'}));
