// One bounded Mini deployment. No group supervisor restart or business submission.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {hostname} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pg from 'pg';
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',history='/Users/barry/apps/crawlv3-history-20260913',dir=history+'/amazon-page-binding-20260913';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),keep=(p,v)=>fs.writeFile(p,typeof v==='string'?v:JSON.stringify(v,null,2),{flag:'wx',mode:0o600});
const execute=promisify(execFile),sleep=ms=>new Promise(r=>setTimeout(r,ms));
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const tests=await read(dir+'/test-results.json');assert.equal(tests.numFailedTests,0);assert.equal(tests.numPassedTests,68);
const manifest=main+'/live/deployment.json',text=await fs.readFile(manifest,'utf8'),before=JSON.parse(text),after=structuredClone(before),status=await read(main+'/status.json');
assert.equal(status.mode,'independent');assert.equal(status.jobs.length,90);assert.ok(status.jobs.every(j=>j.ready));assert.ok(Date.now()-Date.parse(status.at)<20000);
const db=new pg.Pool({connectionString:before.database.connectionString,max:1,statement_timeout:5000});
try{
 const idle=async()=>{assert.equal((await db.query('select count(*)::int n from resource_permit where released_at is null')).rows[0].n,0);assert.equal((await db.query('select count(*)::int n from source_submission_guard')).rows[0].n,0);};
 await idle();
 const roles=['amazon-control','amazon-catalog-source','amazon-catalog-ledger','amazon-product-input','amazon-capture','amazon-file','amazon-review'];
 const oldConfig=before.jobs.find(j=>j.id==='amazon-file').env.V3_AMAZON_LIVE_CONFIG,c=await read(oldConfig);
 assert.equal(c.deliveryPostalCode,'10001');assert.equal(c.linkBatches.length,511);
 const oldBatch=c.linkBatches.find(b=>b.requestId==='df1f6c2b-c8a6-45ab-ad9e-6531a3d06980');assert.ok(oldBatch);assert.equal(oldBatch.entries.length,1);assert.equal(oldBatch.entries[0].entry.listingId,'B0GBX7416D');
 const batch={...oldBatch,requestId:randomUUID()},nextConfig={...c,linkBatches:[...c.linkBatches,batch]};
 const release=main+'/release-amazon-page-binding-20260913';await fs.mkdir(release,{mode:0o700});
 const bytes=await fs.readFile(dir+'/release/amazon-live-worker.js');await fs.writeFile(release+'/amazon-live-worker.js',bytes,{flag:'wx',mode:0o600});
 const buildId=createHash('sha256').update(String(bytes.length)+':').update(bytes).digest('hex');
 await fs.mkdir(dir+'/runtime',{mode:0o700});await keep(dir+'/before.private.json',text);await keep(dir+'/status-before.json',status);
 await keep(dir+'/amazon.private.json',nextConfig);await keep(dir+'/trial.json',{asin:'B0GBX7416D',requestId:batch.requestId,batch,buildId,release});
 for(const id of roles){const j=after.jobs.find(j=>j.id===id);assert.equal(j.env.V3_AMAZON_LIVE_CONFIG,oldConfig);const r=await read(j.env.V3_WORKER_CONFIG);
  j.entry=release+'/amazon-live-worker.js';j.env.V3_WORKER_CONFIG=dir+'/runtime/'+id+'.json';j.env.V3_AMAZON_LIVE_CONFIG=dir+'/amazon.private.json';await keep(j.env.V3_WORKER_CONFIG,{...r,expectedBuildId:buildId});
 }
 for(const j of before.jobs)if(!roles.includes(j.id))assert.deepEqual(after.jobs.find(n=>n.id===j.id),j);
 await keep(dir+'/after.private.json',after);await idle();assert.equal(await fs.readFile(manifest,'utf8'),text);
 await keep(manifest+'.page-binding-next',after);await fs.rename(manifest+'.page-binding-next',manifest);
 const controller=main+'/release-independent-control-20260913/independent-deployment/deployment-launchd.js',restarted=[];
 for(const id of roles){const out=await execute(before.node,[controller,'restart',manifest,id],{timeout:180000,maxBuffer:1024*1024});const result=JSON.parse(out.stdout);assert.equal(result.ready.length,1);assert.equal(result.ready[0].id,id);restarted.push(result.ready[0]);console.log(JSON.stringify({event:'INDEPENDENT_WORKER_READY',...result.ready[0]}));}
 let current;for(let n=0;n<30;n++){const s=await read(main+'/status.json');if(s.jobs.every(j=>j.ready)&&Date.now()-Date.parse(s.at)<15000){current=s;break;}await sleep(1000);}assert.ok(current);assert.equal(current.pid,status.pid);
 for(const j of status.jobs){const now=current.jobs.find(n=>n.id===j.id);if(roles.includes(j.id))assert.notEqual(now.pid,j.pid);else assert.equal(now.pid,j.pid);}
 const workers=[];for(const id of roles){const h=await read(main+'/'+id+'.health.json');assert.equal(h.buildId,buildId);assert.equal(h.event,'WORKER_RUNNING');const out=await execute('/bin/ps',['-p',String(h.pid),'-o','command=']);assert.ok(out.stdout.includes(release+'/amazon-live-worker.js'));workers.push({id,pid:h.pid,buildId:h.buildId,taskQueue:h.taskQueue});}
 await idle();const receipt={at:new Date().toISOString(),buildId,release,workers,monitorPid:current.pid,unrelatedPidsUnchanged:true,ready:90,trialRequestId:batch.requestId,trialSubmitted:false};await keep(dir+'/deployment.json',receipt);console.log(JSON.stringify(receipt));
}finally{await db.end();}
