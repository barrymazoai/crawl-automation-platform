/** Bounded real process startup test. No workflow submissions, provider turns or database writes. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir,readFile,writeFile,open } from "node:fs/promises";
import { join,resolve } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { readGncPrivateJson } from "../src/gnc-config.js";
import { parseWorkerConfig } from "@crawl-automation/v3-worker-runtime";
const [rootArg,basePath,runtimePath]=process.argv.slice(2);assert.ok(rootArg&&basePath&&runtimePath);
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const root=resolve(rootArg);assert.match(root,/^\/Users\/barry\/apps\/crawlv3-channel-restored\.PCrTm6\/swanson-routing-[a-z0-9-]+$/);
const base=await readGncPrivateJson(basePath) as any,runtime=parseWorkerConfig(await readGncPrivateJson(runtimePath));
assert.equal(new URL(base.reviewDatabase.connectionString).pathname,"/crawler_v3_test");assert.equal(base.r2.bucket,"supply-smart-test");
const session=`preflight-${randomUUID()}`,dir=join(root,session),entry=join(root,"swanson-live/channel-label-worker.js");
await mkdir(dir,{mode:0o700});
const configPath=join(dir,"private.json");
await writeFile(configPath,JSON.stringify({root:dir,storageId:"mini-channel-label",database:base.reviewDatabase,
  r2:{...base.r2,prefix:`${base.r2.prefix}/${session}`},r2Credentials:base.r2Credentials,
  codex:{settings:{provider:"openai",model:"gpt-5.6-luna",reasoningEffort:"medium"},executable:"/opt/homebrew/bin/codex",codexHome:"/Users/barry/.codex",
    workRoot:join(dir,"model-work"),runtimeProfileVersion:"gnc-persistent-auth/1",timeoutMs:240000,disabledMcpServers:["node_repl","computer-use"],extractionProtocol:"label-extraction/1"},
  ocrProvider:{endpoint:"http://192.168.0.6:8081/ocr",trustedHttpOrigin:"http://192.168.0.6:8081",provider:"paddle-ocr/1",minScore:0.3},
}),{mode:0o600,flag:"wx"});
const env={...process.env,V3_CHANNEL_LABEL_ENABLED:"true",V3_CHANNEL_LABEL_CONFIG:configPath};
const listing=spawn(process.execPath,[entry,"--list"],{env,stdio:["ignore","pipe","pipe"]});let output="";
listing.stdout.on("data",b=>{output+=b;});const code=await new Promise(r=>listing.once("exit",r));assert.equal(code,0);
const roles=JSON.parse(output),results:any[]=[];
for(const role of roles){
 const path=join(dir,`${role.role}.json`),health=join(dir,`${role.role}.health.json`);
 const providerRequired=["channel-label-text","channel-label-vision"].includes(role.role);
 const business=JSON.parse(await readFile(configPath,"utf8"));
 // Non-model workers must start even on machines without a Codex installation or account directory.
 if(!providerRequired){business.codex.codexHome=join(dir,"no-codex-account");business.codex.executable=join(dir,"no-codex-executable");}
 const businessPath=join(dir,`${role.role}-private.json`);await writeFile(businessPath,JSON.stringify(business),{mode:0o600,flag:"wx"});
 const c=parseWorkerConfig({...runtime,role:role.role,capability:role.capability,compatibility:role.compatibility,contractVersion:role.contractVersion,
   expectedBuildId:role.buildId,queueScope:session,concurrency:1,startupTimeoutMs:90000});
 await writeFile(path,JSON.stringify(c),{mode:0o600,flag:"wx"});
 const log=await open(join(dir,`${role.role}.log`),"wx",0o600);
 const child=spawn(process.execPath,[entry],{env:{...env,V3_CHANNEL_LABEL_CONFIG:businessPath,V3_WORKER_ENABLED:"true",V3_WORKER_CONFIG:path,V3_WORKER_HEALTH_FILE:health},stdio:["ignore",log.fd,log.fd]});await log.close();
 let ready:any=null,forced=false;
 try{
  const until=Date.now()+95000;
  while(Date.now()<until&&child.exitCode===null&&child.signalCode===null){
   try{const h=JSON.parse(await readFile(health,"utf8"));if(h.pid===child.pid&&h.event==="WORKER_RUNNING"){ready=h;break;}}catch{}
   await new Promise(r=>setTimeout(r,250));
  }
 }finally{
  if(child.exitCode===null&&child.signalCode===null)child.kill("SIGTERM");
  const until=Date.now()+25000;while(child.exitCode===null&&child.signalCode===null&&Date.now()<until)await new Promise(r=>setTimeout(r,100));
  if(child.exitCode===null&&child.signalCode===null){forced=true;child.kill("SIGKILL");await new Promise(r=>child.once("exit",r));}
 }
 let final:any=null;try{final=JSON.parse(await readFile(health,"utf8"));}catch{}
 const result={role:role.role,pid:child.pid,ready:Boolean(ready),modelProviderRequired:providerRequired,taskQueue:ready?.taskQueue,stopped:final?.event==="WORKER_STOPPED"&&child.exitCode===0&&!forced,exitCode:child.exitCode,signal:child.signalCode};
 results.push(result);console.log(JSON.stringify(result));
 await writeFile(join(dir,"report.json"),JSON.stringify({session,at:new Date().toISOString(),results,workflowSubmissions:0,modelTurns:0,browserPagesOpened:0},null,2),{mode:0o600});
 if(!result.ready||!result.stopped){process.exitCode=1;break;}
}
console.log(JSON.stringify({report:join(dir,"report.json"),passed:results.length===roles.length&&results.every(r=>r.ready&&r.stopped)}));
