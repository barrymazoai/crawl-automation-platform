import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {Connection,Client} from '@temporalio/client';import pg from 'pg';
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',dir='/Users/barry/apps/crawlv3-history-20260913/worker-resource-audit-20260914',dtc=main+'/dtc-innerbody-v2-20260911',batchRoot=main+'/amazon-pilot-10-20260913',baseRelease=main+'/release-amazon-resource-stall-20260914';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),keep=(p,v)=>fs.writeFile(p,typeof v==='string'?v:JSON.stringify(v,null,2),{flag:'wx',mode:0o600}),exec=promisify(execFile);
// Only read-only queries are retried; the runUntil signal is submitted once.
async function progress(c,h){const until=Date.now()+180000;for(;;){try{return await c.withDeadline(Date.now()+10000,()=>h.query('progress'));}catch(e){if(![4,9,14].includes(e.cause?.code)||Date.now()>until)throw e;await new Promise(r=>setTimeout(r,3000));}}}
assert.equal((await read(dir+'/replay-results.json')).passed,true);const test=await read(dir+'/batch-limit-test-results.json');assert.equal(test.numPassedTests,1);assert.equal(test.numFailedTests,0);
const paths=[main+'/live/deployment.json',dtc+'/private/deployment.json',batchRoot+'/deployment.json'],texts=await Promise.all(paths.map(p=>fs.readFile(p,'utf8'))),before=texts.map(JSON.parse),after=before.map(m=>structuredClone(m)),states=await Promise.all(before.map(m=>read(m.root+'/status.json')));
const scopes=[{label:['channel-label-text','channel-label-vision','channel-label-resources'],workflow:['gnc-core-stream-workflow','catalog-workflow','swanson-product-workflow','swanson-catalog-workflow','channel-label-workflow']},{label:['channel-label-text','channel-label-vision','channel-label-resources'],workflow:['dtc-product-workflow','catalog-workflow','channel-label-workflow']},{batch:['amazon-batch-workflow','amazon-batch-control']}];
for(const s of states){assert.ok(s.jobs.every(j=>j.ready));assert.ok(Date.now()-Date.parse(s.at)<20000);}
const runtime=await read(before[0].jobs.find(j=>j.id==='amazon-brand-workflow').env.V3_WORKER_CONFIG),t=runtime.transport,c=await Connection.connect({address:runtime.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}}),db=new pg.Pool({connectionString:before[0].database.connectionString,max:1,statement_timeout:5000});
try{
 const client=new Client({connection:c,namespace:runtime.namespace}),campaign=client.workflow.getHandle('amazon-history-100-us-10001-20260913'),p=await progress(c,campaign);assert.equal(p.phase,'paused');assert.equal(p.cursor,16);assert.equal(p.totalProducts,100);
 const idle=async()=>{assert.equal((await db.query('select count(*)::int n from resource_permit where released_at is null')).rows[0].n,0);assert.equal((await db.query('select count(*)::int n from source_submission_guard')).rows[0].n,0);};await idle();
 const active=[];for await(const s of client.workflow.list({query:"ExecutionStatus = 'Running'"})){assert.ok(['AmazonHistoryBatchWorkflow','DtcNodeSessionWorkflow'].includes(s.type));active.push({id:s.workflowId,type:s.type});}
 await fs.mkdir(dir+'/runtime',{mode:0o700});const expected=new Map();
 for(let i=0;i<after.length;i++){
  await keep(dir+'/before-'+i+'.private.json',texts[i]);await keep(dir+'/status-before-'+i+'.json',states[i]);
  for(const [group,ids] of Object.entries(scopes[i])){
   let release=baseRelease+'/'+group;
   if(i===1||group==='batch'){
    release=after[i].root+'/release-resource-prevention-20260914-'+group;await fs.mkdir(release,{mode:0o700});
    const source=group==='batch'?dir+'/amazon-batch':baseRelease+'/'+group;
    for(const n of (await fs.readdir(source)).filter(n=>n.endsWith('.js')||n.endsWith('-workflows.cjs'))){await fs.copyFile(source+'/'+n,release+'/'+n,fs.constants.COPYFILE_EXCL);await fs.chmod(release+'/'+n,0o600);}
   }
   const hash=createHash('sha256');for(const n of (await fs.readdir(release)).filter(n=>n.endsWith('.js')||n.endsWith('-workflows.cjs')).sort()){const b=await fs.readFile(release+'/'+n);hash.update(String(b.length)+':').update(b);}const build=hash.digest('hex');
   const entry={label:'channel-label-worker.js',workflow:'product-workflow-worker.js',batch:'amazon-batch-worker.js'}[group];
   for(const id of ids){const j=after[i].jobs.find(j=>j.id===id);assert.ok(j);const old=await read(j.env.V3_WORKER_CONFIG);j.entry=release+'/'+entry;assert.ok(!path.relative(after[i].root,j.entry).startsWith('..'));
    j.env.V3_WORKER_CONFIG=dir+'/runtime/'+i+'-'+id+'.json';await keep(j.env.V3_WORKER_CONFIG,{...old,expectedBuildId:build});expected.set(i+'/'+id,{build,entry:j.entry});}
  }
  for(const old of before[i].jobs)if(!expected.has(i+'/'+old.id))assert.deepEqual(after[i].jobs.find(j=>j.id===old.id),old);await keep(dir+'/after-'+i+'.private.json',after[i]);
 }
 await idle();for(let i=0;i<paths.length;i++){assert.equal(await fs.readFile(paths[i],'utf8'),texts[i]);await keep(paths[i]+'.resource-prevention-next',after[i]);await fs.rename(paths[i]+'.resource-prevention-next',paths[i]);}
 const controller=main+'/release-independent-control-20260913/independent-deployment/deployment-launchd.js',workers=[];
 for(let i=0;i<after.length;i++)for(const id of Object.values(scopes[i]).flat()){
  const result=await exec('/opt/homebrew/bin/node',[controller,'restart',paths[i],id],{timeout:180000,maxBuffer:1048576});assert.equal(JSON.parse(result.stdout).ready[0].id,id);
  const h=await read(after[i].root+'/'+id+'.health.json'),e=expected.get(i+'/'+id);assert.equal(h.buildId,e.build);assert.equal(h.event,'WORKER_RUNNING');assert.ok((await exec('/bin/ps',['-p',String(h.pid),'-o','command='])).stdout.includes(e.entry));
  const row={deployment:i,id,pid:h.pid,buildId:h.buildId};workers.push(row);console.log(JSON.stringify({event:'WORKER_RESTARTED',...row}));
 }
 const samples=[];for(let n=0;n<3;n++){await new Promise(r=>setTimeout(r,6000));const current=await Promise.all(after.map(m=>read(m.root+'/status.json')));for(let i=0;i<current.length;i++){
  assert.equal(current[i].pid,states[i].pid);assert.ok(current[i].jobs.every(j=>j.ready));assert.ok(Date.now()-Date.parse(current[i].at)<15000);
  for(const old of states[i].jobs){const now=current[i].jobs.find(j=>j.id===old.id);if(expected.has(i+'/'+old.id))assert.notEqual(now.pid,old.pid);else assert.equal(now.pid,old.pid);}}
  samples.push({at:new Date().toISOString(),ready:current.map(s=>s.jobs.length)});}
 await idle();const paused=await progress(c,campaign);assert.equal(paused.phase,'paused');assert.equal(paused.cursor,16);assert.equal(paused.stopAfter,null);
 await campaign.signal('runUntil',24);const limited=await progress(c,campaign);assert.equal(limited.stopAfter,24);assert.ok(limited.cursor>=16&&limited.cursor<24);
 const receipt={at:new Date().toISOString(),workers,samples,unrelatedPidsUnchanged:true,monitorsUnchanged:true,windowsDtcRestarted:false,campaign:{id:limited.campaignId,baselineCursor:14,alreadySettled:16,stopAfter:24,phase:limited.phase,cursor:limited.cursor},active};await keep(dir+'/deployment.json',receipt);console.log(JSON.stringify({event:'RESOURCE_PREVENTION_DEPLOYED',workers:workers.length,campaign:receipt.campaign}));
}finally{await db.end();await c.close();}
