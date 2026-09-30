// Mini-only, bounded rollout. Consumers first; Amazon capture last. Never resumes a campaign.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Connection,Client} from '@temporalio/client';
import pg from 'pg';
const [main,work]=process.argv.slice(2),batch=main+'/amazon-pilot-10-20260913',dtc=main+'/dtc-innerbody-v2-20260911';
assert.equal(process.platform,'darwin');
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),keep=(p,v)=>fs.writeFile(p,typeof v==='string'?v:JSON.stringify(v,null,2),{flag:'wx',mode:0o600}),exec=promisify(execFile);
assert.equal((await read(work+'/acceptance.json')).passed,true);
const tests=await read(work+'/test-results.json');assert.equal(tests.numFailedTests,0);assert.equal(tests.numPendingTests,0);assert.ok(tests.numPassedTests>=94);
const paths=[main+'/live/deployment.json',batch+'/deployment.json',dtc+'/private/deployment.json'];
const texts=await Promise.all(paths.map(p=>fs.readFile(p,'utf8'))),before=texts.map(JSON.parse),current=before.map(m=>structuredClone(m)),states=await Promise.all(before.map(m=>read(m.root+'/status.json')));
for(const s of states){assert.ok(s.jobs.every(j=>j.ready));assert.ok(Date.now()-Date.parse(s.at)<20000);}
const runtime=await read(before[1].jobs.find(j=>j.id==='amazon-batch-workflow').env.V3_WORKER_CONFIG),t=runtime.transport;
const connection=await Connection.connect({address:runtime.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
const db=new pg.Pool({connectionString:before[0].database.connectionString,max:1,statement_timeout:5000,options:'-c default_transaction_read_only=on'});
const steps=[['amazon-channel-product-input','plan',0],['amazon-channel-label-plan','label',0],['amazon-channel-label-source','label',0],['amazon-channel-label-manifest','label',0],['amazon-product-input','amazon',0],['amazon-file','amazon',0],['amazon-batch-control','batch',1],['amazon-capture','amazon',0]];
const campaignId='amazon-history-100-us-10001-20260913',workers=[],expected=new Map();
try{
 const client=new Client({connection,namespace:runtime.namespace}),campaign=client.workflow.getHandle(campaignId);
 const paused=async()=>{const p=await campaign.query('progress');assert.equal(p.phase,'paused');assert.equal(p.cursor,24);assert.equal(p.stopAfter,24);assert.equal(p.totalProducts,100);return p;};
 const idle=async()=>{assert.equal((await db.query('SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int n FROM source_submission_guard')).rows[0].n,0);};
 await paused();await idle();
 for await(const s of client.workflow.list({query:"ExecutionStatus = 'Running'"}))assert.ok(['AmazonHistoryBatchWorkflow','DtcNodeSessionWorkflow'].includes(s.type),'Active business task: '+s.type);
 await fs.mkdir(work+'/runtime',{mode:0o700});
 for(let i=0;i<paths.length;i++){await keep(work+'/before-'+i+'.private.json',texts[i]);await keep(work+'/status-before-'+i+'.json',states[i]);}
 const releases=new Map();
 for(const group of ['plan','label','amazon','batch','export']){
  const source=work+'/candidate/'+group,release=(group==='batch'?batch:main)+'/release-purchase-conditions-20260914/'+group;
  await fs.mkdir(path.dirname(release),{recursive:true,mode:0o700});await fs.mkdir(release,{mode:0o700});
  for(const n of (await fs.readdir(source)).filter(n=>n.endsWith('.js'))){await fs.copyFile(source+'/'+n,release+'/'+n,fs.constants.COPYFILE_EXCL);await fs.chmod(release+'/'+n,0o600);}
  if(group==='batch'){
   const old=path.dirname(before[1].jobs.find(j=>j.id==='amazon-batch-control').entry)+'/amazon-batch-workflows.cjs';
   await fs.copyFile(old,release+'/amazon-batch-workflows.cjs',fs.constants.COPYFILE_EXCL);
   assert.deepEqual(await fs.readFile(old),await fs.readFile(release+'/amazon-batch-workflows.cjs'));
  }
  const hash=createHash('sha256');for(const n of (await fs.readdir(release)).filter(n=>n.endsWith('.js')||n.endsWith('-workflows.cjs')).sort()){const b=await fs.readFile(release+'/'+n);hash.update(String(b.length)+':').update(b);}
  releases.set(group,{release,build:hash.digest('hex')});
 }
 const controller=main+'/release-independent-control-20260913/independent-deployment/deployment-launchd.js';
 for(const [id,group,i] of steps){
  await paused();await idle();
  const next=structuredClone(current[i]),j=next.jobs.find(j=>j.id===id),r=await read(j.env.V3_WORKER_CONFIG),release=releases.get(group);
  const entry={amazon:'amazon-live-worker.js',plan:'channel-plan-worker.js',label:'channel-label-worker.js',batch:'amazon-batch-worker.js'}[group];
  j.entry=release.release+'/'+entry;assert.ok(!path.relative(next.root,j.entry).startsWith('..'));
  j.env.V3_WORKER_CONFIG=work+'/runtime/'+id+'.json';await keep(j.env.V3_WORKER_CONFIG,{...r,expectedBuildId:release.build});
  for(const other of current[i].jobs)if(other.id!==id)assert.deepEqual(next.jobs.find(j=>j.id===other.id),other);
  assert.equal(await fs.readFile(paths[i],'utf8'),texts[i]);
  const nextText=JSON.stringify(next,null,2);await keep(paths[i]+'.purchase-next',nextText);await fs.rename(paths[i]+'.purchase-next',paths[i]);texts[i]=nextText;current[i]=next;
  console.log(JSON.stringify({event:'RESTARTING_ONE_WORKER',id}));
  const result=await exec('/opt/homebrew/bin/node',[controller,'restart',paths[i],id],{timeout:180000,maxBuffer:1048576});assert.equal(JSON.parse(result.stdout).ready[0].id,id);
  const h=await read(next.root+'/'+id+'.health.json');assert.equal(h.buildId,release.build);assert.equal(h.event,'WORKER_RUNNING');
  assert.ok((await exec('/bin/ps',['-p',String(h.pid),'-o','command='])).stdout.includes(j.entry));
  expected.set(i+'/'+id,{build:release.build,entry:j.entry});workers.push({deployment:i,id,pid:h.pid,buildId:h.buildId});
  await keep(work+'/restarted-'+id+'.json',workers.at(-1));console.log(JSON.stringify({event:'WORKER_RESTARTED',...workers.at(-1)}));
 }
 const samples=[];
 for(let n=0;n<3;n++){
  await new Promise(r=>setTimeout(r,6000));const now=await Promise.all(current.map(m=>read(m.root+'/status.json')));
  for(let i=0;i<now.length;i++){
   assert.equal(now[i].pid,states[i].pid);assert.ok(now[i].jobs.every(j=>j.ready));assert.ok(Date.now()-Date.parse(now[i].at)<15000);
   for(const old of states[i].jobs){const job=now[i].jobs.find(j=>j.id===old.id);if(expected.has(i+'/'+old.id))assert.notEqual(job.pid,old.pid);else assert.equal(job.pid,old.pid);}
  }
  samples.push({at:new Date().toISOString(),ready:now.map(s=>s.jobs.length)});
 }
 await idle();const p=await paused();
 const pollers=[];
 for(const [id,,i] of steps){
  const h=await read(current[i].root+'/'+id+'.health.json');
  const queue=await connection.workflowService.describeTaskQueue({namespace:runtime.namespace,taskQueue:{name:h.taskQueue},taskQueueType:2});
  assert.ok(queue.pollers?.some(p=>p.identity===h.identity),'New Worker is not polling: '+id);
  pollers.push({id,taskQueue:h.taskQueue,identity:h.identity});
 }
 assert.equal(await fs.readFile(paths[2],'utf8'),texts[2]);
 const report={at:new Date().toISOString(),passed:true,workers,samples,pollers,unrelatedPidsUnchanged:true,monitorsUnchanged:true,workflowExecutablesUnchanged:true,windowsDtcRestarted:false,
  exportEntry:releases.get('export').release+'/history-cli.js',campaign:{id:campaignId,phase:p.phase,cursor:p.cursor,stopAfter:p.stopAfter,total:p.totalProducts},productionObservationsSubmitted:0};
 await keep(work+'/deployment.json',report);console.log(JSON.stringify({event:'PURCHASE_CONDITIONS_DEPLOYED',workers:workers.length,campaign:report.campaign}));
}finally{await db.end();await connection.close();}
