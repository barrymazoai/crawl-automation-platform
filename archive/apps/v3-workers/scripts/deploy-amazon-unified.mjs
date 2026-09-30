// Roll out only the affected Amazon roles. The resource monitor restarts independently.
import fs from 'node:fs/promises';
import path from 'node:path';
import {hostname,homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import pg from 'pg';
import {Client,Connection} from '@temporalio/client';
const [work]=process.argv.slice(2),main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',manifest=main+'/live/deployment.json';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),keep=(p,v)=>fs.writeFile(p,typeof v==='string'?v:JSON.stringify(v,null,2),{flag:'wx',mode:0o600});
const exec=promisify(execFile),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const lib=await import(work+'/candidate/acceptance/purchase-conditions-inspect.js');
const tests=await read(work+'/test-results.json');assert.equal(tests.numFailedTests,0);assert.equal(tests.numPendingTests,0);assert.ok(tests.numPassedTests>=204);
assert.equal((await read(work+'/acceptance-browser/report.json')).passed,true);assert.equal((await read(work+'/acceptance-vision/report.json')).passed,true);
let saved=await fs.readFile(manifest,'utf8');const m=JSON.parse(saved),before=await read(main+'/status.json');assert.ok(before.jobs.every(j=>j.ready));assert.ok(Date.now()-Date.parse(before.at)<20000);
const batch=await read(main+'/amazon-pilot-10-20260913/deployment.json'),runtime=await read(batch.jobs.find(j=>j.id==='amazon-batch-workflow').env.V3_WORKER_CONFIG),t=runtime.transport;
const connection=await Connection.connect({address:runtime.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
const db=new pg.Pool({connectionString:m.database.connectionString,max:1,statement_timeout:5000}),client=new Client({connection,namespace:runtime.namespace});
const controller=main+'/release-independent-control-20260913/independent-deployment/deployment-launchd.js';
const workers=[],changed=new Set(),releaseRoot=main+'/release-amazon-unified-20260914';
try{
 const paused=async()=>{const s=await client.workflow.getHandle('amazon-history-100-us-10001-20260913').query('progress');assert.equal(s.phase,'paused');assert.equal(s.cursor,24);assert.equal(s.stopAfter,24);};
 const idle=async()=>{await paused();assert.equal((await db.query('SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int n FROM source_submission_guard')).rows[0].n,0);};
 await idle();for await(const s of client.workflow.list({query:"ExecutionStatus = 'Running'"}))assert.ok(['AmazonHistoryBatchWorkflow','DtcNodeSessionWorkflow'].includes(s.type));
 await fs.mkdir(work+'/runtime',{mode:0o700});await keep(work+'/deployment-before.private.json',saved);await keep(work+'/status-before.json',before);
 const releases={};
 for(const group of ['amazon','plan','label','export']){
  const dest=releaseRoot+'/'+group;await fs.mkdir(dest,{recursive:true,mode:0o700});const hash=createHash('sha256');
  for(const n of (await fs.readdir(work+'/candidate/'+group)).filter(n=>n.endsWith('.js')).sort()){
   const bytes=await fs.readFile(work+'/candidate/'+group+'/'+n);await fs.writeFile(dest+'/'+n,bytes,{flag:'wx',mode:0o600});hash.update(String(bytes.length)+':').update(bytes);
  }releases[group]={dir:dest,build:hash.digest('hex')};
 }
 const oldConfig=m.jobs.find(j=>j.id==='amazon-capture').env.V3_AMAZON_LIVE_CONFIG,c=await read(oldConfig),vision=await read(m.jobs.find(j=>j.id==='amazon-channel-label-vision').env.V3_CHANNEL_LABEL_CONFIG);
 const nextConfig=lib.AmazonLiveConfigSchema.parse({...c,evidencePolicy:'label-image-first/5',visionConfigFingerprint:lib.CodexVisionProvider.describe(vision.codex).configFingerprint});
 assert.equal(nextConfig.labelResources.reviewStopCheck,true);assert.equal(nextConfig.deliveryPostalCode,'10001');await keep(work+'/amazon.private.json',nextConfig);
 const entries={amazon:'amazon-live-worker.js',plan:'channel-plan-worker.js',label:'channel-label-worker.js'};
 const steps=[['amazon-channel-product-input','plan'],...['plan','source','manifest','vision','ocr','collection'].map(r=>['amazon-channel-label-'+r,'label']),...['control','catalog-source','catalog-ledger','product-input','file','review','capture'].map(r=>['amazon-'+r,'amazon'])];
 for(const [id,group] of steps){
  await idle();const j=m.jobs.find(j=>j.id===id);assert.ok(j);const r=await read(j.env.V3_WORKER_CONFIG),release=releases[group];
  j.entry=release.dir+'/'+entries[group];j.env.V3_WORKER_CONFIG=work+'/runtime/'+id+'.json';
  await keep(j.env.V3_WORKER_CONFIG,{...r,expectedBuildId:release.build,...(['amazon-channel-label-ocr','amazon-channel-label-vision'].includes(id)?{concurrency:2}:{})});
  if(group==='amazon'){assert.equal(j.env.V3_AMAZON_LIVE_CONFIG,oldConfig);j.env.V3_AMAZON_LIVE_CONFIG=work+'/amazon.private.json';}
  assert.equal(await fs.readFile(manifest,'utf8'),saved);saved=JSON.stringify(m,null,2);await keep(manifest+'.unified-next',saved);await fs.rename(manifest+'.unified-next',manifest);
  console.log(JSON.stringify({event:'RESTARTING_ONE_WORKER',id}));
  const result=await exec(m.node,[controller,'restart',manifest,id],{timeout:180000,maxBuffer:1048576});assert.equal(JSON.parse(result.stdout).ready[0].id,id);
  const h=await read(main+'/'+id+'.health.json');assert.equal(h.event,'WORKER_RUNNING');assert.equal(h.buildId,release.build);assert.ok((await exec('/bin/ps',['-p',String(h.pid),'-o','command='])).stdout.includes(j.entry));
  workers.push({id,pid:h.pid,buildId:h.buildId});changed.add(id);await keep(work+'/restarted-'+id+'.json',workers.at(-1));console.log(JSON.stringify({event:'WORKER_RESTARTED',...workers.at(-1)}));
 }
 await idle();
 // Only this monitor stops. Its finally block never signals a Worker.
 const model=m.resources.find(r=>r.resourceId==='mini-model-account');assert.equal(model.capacity,1);
 const scope=createHash('sha256').update(JSON.stringify([m.host,path.resolve(m.root)])).digest('hex').slice(0,16),label='com.crawlv3.m.'+scope,domain='gui/'+process.getuid();
 const monitorState=await read(main+'/status.json');const plist=homedir()+'/Library/LaunchAgents/'+label+'.plist';
 assert.ok((await fs.readFile(plist,'utf8')).includes(controller));await keep(work+'/resource-change-intent.json',{at:new Date().toISOString(),resourceId:model.resourceId,from:1,to:2,monitorPid:monitorState.pid});
 await exec('/bin/launchctl',['bootout',domain+'/'+label],{timeout:180000});
 let absent=false;for(let i=0;i<100;i++){try{process.kill(monitorState.pid,0);}catch(e){if(e.code==='ESRCH'){absent=true;break;}throw e;}await sleep(100);}assert.ok(absent);assert.equal(await fs.stat(main+'/supervisor.lock').then(()=>true,e=>e.code==='ENOENT'?false:Promise.reject(e)),false);
 await idle();const owner=JSON.stringify([m.host,path.resolve(m.root)]);
 await db.query('BEGIN');try{
  await db.query('SELECT resource_id FROM resource_capacity WHERE resource_id=$1 FOR UPDATE',[model.resourceId]);
  assert.equal((await db.query('SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL')).rows[0].n,0);
  assert.equal((await db.query('UPDATE resource_capacity SET capacity=2 WHERE resource_id=$1 AND capacity=1 AND controller=$2',[model.resourceId,owner])).rowCount,1);await db.query('COMMIT');
 }catch(e){await db.query('ROLLBACK');throw e;}
 model.capacity=2;assert.equal(await fs.readFile(manifest,'utf8'),saved);saved=JSON.stringify(m,null,2);await keep(manifest+'.unified-next',saved);await fs.rename(manifest+'.unified-next',manifest);
 await exec('/bin/launchctl',['bootstrap',domain,plist],{timeout:30000});
 let after;for(let n=0;n<60;n++){after=await read(main+'/status.json');const resources=(await db.query('SELECT healthy,health_until>now() fresh FROM resource_capacity WHERE resource_id=ANY($1)',[m.resources.map(r=>r.resourceId)])).rows;if(after.pid!==before.pid&&after.jobs.every(j=>j.ready)&&Date.now()-Date.parse(after.at)<15000&&resources.every(r=>r.healthy&&r.fresh))break;await sleep(2000);}
 assert.notEqual(after.pid,before.pid);assert.ok(after.jobs.every(j=>j.ready));assert.ok(Date.now()-Date.parse(after.at)<15000);
 for(const old of before.jobs){const next=after.jobs.find(j=>j.id===old.id);if(changed.has(old.id))assert.notEqual(next.pid,old.pid);else assert.equal(next.pid,old.pid);}
 for(const w of workers){const h=await read(main+'/'+w.id+'.health.json'),q=await connection.workflowService.describeTaskQueue({namespace:runtime.namespace,taskQueue:{name:h.taskQueue},taskQueueType:2});assert.ok(q.pollers?.some(p=>p.identity===h.identity),'No poller '+w.id);}
 const resources=(await db.query('SELECT resource_id,capacity,healthy,health_until>now() fresh FROM resource_capacity WHERE resource_id=ANY($1)',[m.resources.map(r=>r.resourceId)])).rows;assert.ok(resources.every(r=>r.healthy&&r.fresh));await idle();
 await keep(work+'/deployment.json',{at:new Date().toISOString(),passed:true,workers,resources,oldCampaignPausedAt:24,unrelatedPidsUnchanged:true,workflowExecutablesUnchanged:true,monitor:{before:before.pid,after:after.pid},exportEntry:releases.export.dir+'/history-cli.js'});
 console.log(JSON.stringify({event:'AMAZON_UNIFIED_DEPLOYED',workers:workers.length,resources}));
}finally{await db.end();await connection.close();}
