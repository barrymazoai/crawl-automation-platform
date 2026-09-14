// Mini-only selective deployment for the existing paused 100-product campaign.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {hostname} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Connection,Client} from '@temporalio/client';
import pg from 'pg';
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',dir='/Users/barry/apps/crawlv3-history-20260913/amazon-resource-stall-fix-20260914',pilot=main+'/amazon-pilot-10-20260913',release=main+'/release-amazon-resource-stall-20260914';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),keep=(p,v)=>fs.writeFile(p,typeof v==='string'?v:JSON.stringify(v,null,2),{flag:'wx',mode:0o600});
const exec=promisify(execFile),sleep=ms=>new Promise(r=>setTimeout(r,ms));
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
for(const [file,count] of [['unit-results.json',93],['recovery-unit-results.json',17],['integration-results.json',2]]){const t=await read(dir+'/'+file);assert.equal(t.numFailedTests,0);assert.equal(t.numPassedTests,count);}
assert.equal((await read(dir+'/replay-results.json')).passed,true);assert.equal((await read(dir+'/recovery-audit.json')).status,'recoverable');
const paths=[main+'/live/deployment.json',pilot+'/deployment.json'],originals=await Promise.all(paths.map(p=>fs.readFile(p,'utf8'))),before=originals.map(JSON.parse),after=before.map(m=>structuredClone(m));
const statuses=await Promise.all([main,pilot].map(p=>read(p+'/status.json')));
for(const [i,s] of statuses.entries()){assert.equal(s.mode,'independent');assert.equal(s.jobs.length,i===0?90:2);assert.ok(s.jobs.every(j=>j.ready));assert.ok(Date.now()-Date.parse(s.at)<30000);}
const runtime=await read(before[0].jobs.find(j=>j.id==='amazon-brand-workflow').env.V3_WORKER_CONFIG),t=runtime.transport;
const connection=await Connection.connect({address:runtime.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
const client=new Client({connection,namespace:runtime.namespace}),batch=client.workflow.getHandle('amazon-history-100-us-10001-20260913');
const db=new pg.Pool({connectionString:before[0].database.connectionString,max:1,statement_timeout:5000,connectionTimeoutMillis:5000});
try{
 const progress=await batch.query('progress');assert.equal(progress.phase,'paused');assert.equal(progress.cursor,9);assert.equal(progress.totalProducts,100);assert.equal(progress.requestId,'24e1a133-c988-41a4-9143-2a8814645b8c');
 const held=(await db.query('select permit_id from resource_permit where released_at is null')).rows;assert.deepEqual(held.map(p=>p.permit_id),['permit-01a09b9c-83f3-7dfc-8b5a-5f48266a9beb-2']);
 const scopes={label:['amazon-channel-label-text','amazon-channel-label-vision','amazon-channel-label-resources'],workflow:['amazon-product-workflow','amazon-channel-label-workflow','amazon-catalog-workflow'],amazon:['amazon-control'],batch:['amazon-batch-workflow','amazon-batch-control']};
 const builds={};await fs.mkdir(release,{mode:0o700});await fs.mkdir(dir+'/runtime',{mode:0o700});
 for(const group of ['label','workflow','amazon','batch','recovery']){
  const source=dir+(group==='batch'?'/amazon-batch':'/resource-stall/'+group),target=release+'/'+group;await fs.mkdir(target,{mode:0o700});
  const names=(await fs.readdir(source)).filter(n=>n.endsWith('.js')||n.endsWith('-workflows.cjs')).sort();assert.ok(names.length>0);const hash=createHash('sha256');
  for(const n of names){const b=await fs.readFile(source+'/'+n);await fs.writeFile(target+'/'+n,b,{flag:'wx',mode:0o600});hash.update(String(b.length)+':').update(b);}
  builds[group]=hash.digest('hex');
 }
 const oldBatchConfig=before[1].jobs[0].env.V3_AMAZON_BATCH_CONFIG,bc=await read(oldBatchConfig);assert.equal(bc.campaignId,progress.campaignId);assert.ok(before[1].jobs.every(j=>j.env.V3_AMAZON_BATCH_CONFIG===oldBatchConfig));
 await keep(dir+'/batch.private.json',{...bc,modelRecoveryHelper:release+'/recovery/recover-amazon-label-stop.js'});
 const entries={label:'channel-label-worker.js',workflow:'product-workflow-worker.js',amazon:'amazon-live-worker.js',batch:'amazon-batch-worker.js'};
 for(const [group,ids] of Object.entries(scopes))for(const id of ids){const index=group==='batch'?1:0,j=after[index].jobs.find(j=>j.id===id);assert.ok(j);const r=await read(j.env.V3_WORKER_CONFIG);
  j.entry=release+'/'+group+'/'+entries[group];j.env.V3_WORKER_CONFIG=dir+'/runtime/'+id+'.json';await keep(j.env.V3_WORKER_CONFIG,{...r,expectedBuildId:builds[group]});
  if(index===1)j.env.V3_AMAZON_BATCH_CONFIG=dir+'/batch.private.json';
 }
 const ids=Object.values(scopes).flat();
 for(const [i,m] of before.entries()){for(const j of m.jobs)if(!ids.includes(j.id))assert.deepEqual(after[i].jobs.find(n=>n.id===j.id),j);await keep(dir+'/before-'+i+'.private.json',originals[i]);await keep(dir+'/status-before-'+i+'.json',statuses[i]);await keep(dir+'/after-'+i+'.private.json',after[i]);}
 // All new artifacts/configs exist and the exact campaign is still paused before activation.
 assert.equal((await batch.query('progress')).phase,'paused');
 for(let i=0;i<paths.length;i++){assert.equal(await fs.readFile(paths[i],'utf8'),originals[i]);await keep(paths[i]+'.resource-stall-next',after[i]);await fs.rename(paths[i]+'.resource-stall-next',paths[i]);}
 const controller=main+'/release-independent-control-20260913/independent-deployment/deployment-launchd.js',workers=[];
 for(const [group,roles] of Object.entries(scopes))for(const id of roles){
  const i=group==='batch'?1:0,out=await exec(before[i].node,[controller,'restart',paths[i],id],{timeout:180000,maxBuffer:1024*1024}),result=JSON.parse(out.stdout);
  assert.equal(result.ready.length,1);assert.equal(result.ready[0].id,id);const health=await read(before[i].root+'/'+id+'.health.json');assert.equal(health.event,'WORKER_RUNNING');assert.equal(health.buildId,builds[group]);
  assert.ok((await exec('/bin/ps',['-p',String(health.pid),'-o','command='])).stdout.includes(release+'/'+group+'/'+entries[group]));
  const row={id,pid:health.pid,buildId:health.buildId,taskQueue:health.taskQueue};workers.push(row);console.log(JSON.stringify({event:'INDEPENDENT_WORKER_READY',...row}));
 }
 const samples=[];
 for(let n=0;n<3;n++){
  await sleep(6000);const current=await Promise.all([main,pilot].map(p=>read(p+'/status.json')));
  for(const [i,s] of current.entries()){assert.ok(s.jobs.every(j=>j.ready));assert.ok(Date.now()-Date.parse(s.at)<15000);assert.equal(s.pid,statuses[i].pid);
   for(const old of statuses[i].jobs){const now=s.jobs.find(j=>j.id===old.id);if(ids.includes(old.id))assert.notEqual(now.pid,old.pid);else assert.equal(now.pid,old.pid);}}
  samples.push({at:new Date().toISOString(),ready:current.map(s=>s.jobs.length)});
 }
 const receipt={at:new Date().toISOString(),builds,release,workers,unrelatedPidsUnchanged:true,samples,batch:await batch.query('progress'),resumed:false};await keep(dir+'/deployment.json',receipt);console.log(JSON.stringify({event:'AMAZON_RESOURCE_STALL_DEPLOYED',workers:workers.length,unrelatedPidsUnchanged:true,resumed:false}));
}finally{await db.end();await connection.close();}
