import fs from 'node:fs/promises';import {spawn,execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import assert from 'node:assert/strict';import pg from 'pg';
const root='/Users/barry/apps/crawlv3-batch-a.UiA4dx',history='/Users/barry/apps/crawlv3-history-20260913',dir=history+'/amazon-2000-us-20260913',tools=history+'/amazon-2000-tools',release=root+'/release-amazon-links-20260913';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const retain=async(p,v)=>{const b=typeof v==='string'?v:JSON.stringify(v,null,2);try{await fs.writeFile(p,b,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;assert.equal(await fs.readFile(p,'utf8'),b);}return p;};
assert.equal(process.platform,'darwin');const tests=await read(tools+'/tests-v2.json');assert.equal(tests.numFailedTests,0);assert.equal(tests.numPassedTests,28);
const manifestPath=root+'/live/deployment.json',beforeBytes=await fs.readFile(manifestPath,'utf8'),before=JSON.parse(beforeBytes),config=await read(dir+'/amazon.private.json');
assert.equal(config.deliveryPostalCode,'10001');assert.equal(config.scope.region,'US');assert.equal(config.linkBatches.flatMap(b=>b.entries).length,2000);
const db=new pg.Pool({connectionString:before.database.connectionString,max:1,connectionTimeoutMillis:5000,statement_timeout:5000});
try{
 for(const sql of ['select count(*)::int n from source_submission_guard','select count(*)::int n from resource_permit where released_at is null'])assert.equal((await db.query(sql)).rows[0].n,0);
 await fs.mkdir(release,{recursive:true,mode:0o700});const bytes=await fs.readFile(tools+'/amazon-links/amazon-live-worker.js');await retain(release+'/amazon-live-worker.js',bytes.toString());
 const build=createHash('sha256').update(String(bytes.length)+':').update(bytes).digest('hex');
 const after=structuredClone(before),roles=['amazon-control','amazon-catalog-source','amazon-catalog-ledger','amazon-product-input','amazon-capture','amazon-file','amazon-review'];
 await fs.mkdir(dir+'/runtime',{recursive:true,mode:0o700});await fs.mkdir(dir+'/preflight',{recursive:true,mode:0o700});
 const checks=[];
 for(const id of roles){const j=after.jobs.find(j=>j.id===id);assert.ok(j);const runtime=await read(j.env.V3_WORKER_CONFIG);runtime.expectedBuildId=build;
  j.entry=release+'/amazon-live-worker.js';j.env.V3_WORKER_CONFIG=await retain(dir+'/runtime/'+id+'.json',runtime);j.env.V3_AMAZON_LIVE_CONFIG=dir+'/amazon.private.json';
  const probe={...runtime,queueScope:'amazon-links-preflight-20260913',hostId:'mini-links-preflight-'+id};const cp=await retain(dir+'/preflight/'+id+'.runtime.json',probe),health=dir+'/preflight/'+id+'.health.json',log=await fs.open(dir+'/preflight/'+id+'.log','a',0o600);
  const child=spawn(before.node,[j.entry],{env:{...process.env,...j.env,V3_WORKER_CONFIG:cp,V3_WORKER_HEALTH_FILE:health},stdio:['ignore',log.fd,log.fd]});await log.close();
  let ready=false;try{const until=Date.now()+60000;while(Date.now()<until&&child.exitCode===null){try{const h=await read(health);if(h.pid===child.pid&&h.event==='WORKER_RUNNING'){ready=true;break;}}catch{}await sleep(500);}assert.ok(ready,id+' preflight ready');}finally{if(child.exitCode===null)child.kill('SIGTERM');const until=Date.now()+20000;while(child.exitCode===null&&child.signalCode===null&&Date.now()<until)await sleep(100);assert.equal(child.exitCode,0,id+' normal stop');}
  checks.push({id,ready,exitCode:child.exitCode});
 }
 for(const j of before.jobs)if(!roles.includes(j.id))assert.deepEqual(after.jobs.find(x=>x.id===j.id),j);
 await retain(dir+'/deployment-before.private.json',beforeBytes);await retain(dir+'/deployment-after.private.json',after);await retain(dir+'/preflight.json',{build,checks});
 assert.equal(await fs.readFile(manifestPath,'utf8'),beforeBytes);
 const status=await read(root+'/status.json');assert.ok(Date.now()-Date.parse(status.at)<15000);assert.ok(status.jobs.every(j=>j.ready));
 for(const sql of ['select count(*)::int n from source_submission_guard','select count(*)::int n from resource_permit where released_at is null'])assert.equal((await db.query(sql)).rows[0].n,0);
 execFileSync('/bin/launchctl',['kill','SIGTERM','gui/501/com.crawlv3.batch-a']);
 let stopped=false;for(let n=0;n<350;n++){try{await fs.access(root+'/supervisor.lock');}catch(e){if(e.code==='ENOENT'){stopped=true;break;}throw e;}await sleep(100);}assert.ok(stopped,'supervisor own lock must be removed by normal stop');
 const next=manifestPath+'.amazon-links-next';await fs.writeFile(next,JSON.stringify(after,null,2),{mode:0o600,flag:'wx'});await fs.rename(next,manifestPath);
 execFileSync('/bin/launchctl',['kickstart','gui/501/com.crawlv3.batch-a']);
 let ready;for(let n=0;n<120;n++){const s=await read(root+'/status.json');if(s.pid!==status.pid&&Date.now()-Date.parse(s.at)<15000&&s.jobs.length===90&&s.jobs.every(j=>j.ready)&&s.dependencies.every(d=>d.healthy)){ready=s;break;}await sleep(1000);}assert.ok(ready,'new supervisor readiness');
 await retain(dir+'/deployment-result.json',{at:new Date().toISOString(),build,release,oldPid:status.pid,pid:ready.pid,ready:90,changed:roles,workflowChanges:0,windowsChanges:0});console.log(JSON.stringify({build,pid:ready.pid,ready:90,changed:roles}));
}finally{await db.end();}
