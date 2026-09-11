/** Upgrade only the existing Swanson product input and two streaming workflow jobs after replay and drain. No new submission or business retry. */
import fs from 'node:fs/promises';import assert from 'node:assert/strict';import{hostname}from'node:os';import{createHash}from'node:crypto';import{createRequire}from'node:module';import{promisify}from'node:util';import{execFile}from'node:child_process';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);const mode=process.argv[2];assert.ok(['--prepare','--activate'].includes(mode));
const root='/Users/barry/apps/crawlv3-batch-a.UiA4dx',resident=root+'/live/channel-resident-20260910-v2',dir=root+'/live/channel-stream-20260910',release=root+'/release-channel-stream-20260910',read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const require=createRequire(root+'/package.json'),{Client,Connection}=require('@temporalio/client'),{Worker}=require('@temporalio/worker'),pg=require('pg');
const tests=await read(root+'/channel-stream-tests-20260910/tests.json');assert.equal(tests.success,true);assert.equal(tests.numTotalTests,48);assert.equal(tests.numFailedTests,0);
const proof=await read(root+'/channel-stream-tests-20260910/channel-stream-proof.json');assert.equal(proof.passed,true);assert.equal(proof.replays,6);
const previousBytes=await fs.readFile(root+'/live/deployment.json'),previous=JSON.parse(previousBytes);assert.equal(previous.jobs.length,61);
if(mode==='--prepare'){
 await fs.mkdir(dir,{mode:0o700});await fs.mkdir(dir+'/evidence',{mode:0o700});
 await fs.cp(root+'/staging-channel-stream-20260910',release,{recursive:true,errorOnExist:true,force:false});
 const code=(await fs.readdir(release)).filter(n=>n.endsWith('.js')).sort();
 async function hash(names){const h=createHash('sha256');for(const n of names){const bytes=await fs.readFile(release+'/'+n);h.update(String(bytes.length));h.update(':');h.update(bytes);}return h.digest('hex');}
 const activityBuild=await hash(code),buildId=await hash([...code,'product-workflows.cjs'].sort());
 const manifest=structuredClone(previous),jobs=[];for(const j of manifest.jobs.filter(j=>['swanson-product-input','swanson-product-workflow','channel-label-workflow'].includes(j.id))){const r=await read(j.env.V3_WORKER_CONFIG),workflow=j.entry.endsWith('/product-workflow-worker.js');r.expectedBuildId=workflow?buildId:activityBuild;j.entry=release+'/'+(workflow?'product-workflow-worker.js':'swanson-live-worker.js');j.env.V3_WORKER_CONFIG=dir+'/'+j.id+'.runtime.json';await fs.writeFile(j.env.V3_WORKER_CONFIG,JSON.stringify(r),{mode:0o600,flag:'wx'});jobs.push(j.id);}assert.equal(jobs.length,3);
 await fs.writeFile(dir+'/previous-deployment.json',previousBytes,{mode:0o600,flag:'wx'});await fs.writeFile(dir+'/deployment.json',JSON.stringify(manifest),{mode:0o600,flag:'wx'});await fs.writeFile(dir+'/ready.json',JSON.stringify({buildId,jobs,release}),{mode:0o600,flag:'wx'});
}
assert.deepEqual(await fs.readFile(dir+'/previous-deployment.json'),previousBytes,'Live deployment changed');
const ready=await read(dir+'/ready.json'),runtime=await read(resident+'/swanson-brand-workflow.runtime.json'),t=runtime.transport;
const verifiedHash=createHash('sha256');for(const name of (await fs.readdir(release)).filter(n=>n.endsWith('.js')||n==='product-workflows.cjs').sort()){const bytes=await fs.readFile(release+'/'+name);verifiedHash.update(String(bytes.length));verifiedHash.update(':');verifiedHash.update(bytes);}assert.equal(verifiedHash.digest('hex'),ready.buildId);
const connection=await Connection.connect({address:runtime.address,tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
const db=new pg.Pool({connectionString:previous.database.connectionString,options:'-c default_transaction_read_only=on',statement_timeout:5000});
try{
 const client=new Client({connection,namespace:runtime.namespace}),results=[],active=[],types=new Set(['GncLeasedProductWorkflow','CatalogWorkflow','CatalogProductWorkflow','BrandCollectionWorkflow','ScheduleIntakeWorkflow','SwansonCatalogProductWorkflow','ChannelSavedLabelWorkflow','ChannelStreamingLabelWorkflow']);
 const recorded=mode==='--activate'?await read(dir+'/evidence/replay-prepare.json'):null;if(recorded)assert.equal(recorded.passed,true);
 for await(const w of client.workflow.list()){
  if(w.status.name==='RUNNING'){active.push(w.workflowId);continue;}if(!types.has(w.type))continue;
  const prior=recorded?.results.find(r=>r.workflowId===w.workflowId&&r.runId===w.runId&&r.type===w.type);if(prior){results.push(prior);continue;}
  const history=await client.workflow.getHandle(w.workflowId,w.runId).fetchHistory();await Worker.runReplayHistory({workflowBundle:{codePath:release+'/product-workflows.cjs'}},history,w.workflowId);
  results.push({workflowId:w.workflowId,runId:w.runId,type:w.type,events:history.events.length});
 }
 assert.ok(results.some(r=>r.type==='SwansonCatalogProductWorkflow'));assert.ok(results.some(r=>r.type==='GncLeasedProductWorkflow'));
 await fs.writeFile(dir+'/evidence/replay-'+mode.slice(2)+'.json',JSON.stringify({passed:true,at:new Date().toISOString(),results,active,activityCalls:0},null,2));
 if(mode==='--prepare'){console.log(JSON.stringify({prepared:true,jobs:ready.jobs,replays:results.length,active:active.length}));process.exitCode=0;}
 else{
  const preflight=await read(dir+'/evidence/preflight.json');assert.equal(preflight.passed,true);assert.equal(preflight.results.length,3);for(const job of ready.jobs)assert.ok(preflight.results.some(r=>r.role===job&&r.ready&&r.normalExit));
  assert.equal(active.length,0,'Drain active workflows before activation');for(const sql of ['SELECT count(*)::int n FROM source_submission_guard','SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL'])assert.equal((await db.query(sql)).rows[0].n,0);
  const run=promisify(execFile),label=`gui/${process.getuid()}/com.crawlv3.batch-a`;await run('/bin/launchctl',['kill','SIGTERM',label]);let stopped=false;
  for(let i=0;i<160;i++){try{await fs.stat(root+'/supervisor.lock');}catch(e){if(e.code==='ENOENT'){stopped=true;break;}throw e;}await new Promise(r=>setTimeout(r,250));}assert.ok(stopped);
  const next=await fs.readFile(dir+'/deployment.json');await fs.writeFile(root+'/live/deployment.next.json',next,{mode:0o600});await fs.rename(root+'/live/deployment.next.json',root+'/live/deployment.json');await run('/bin/launchctl',['kickstart',label]);
  const samples=[];let consecutive=0;const until=Date.now()+150000;
  while(Date.now()<until){const s=await read(root+'/status.json');if(Date.now()-Date.parse(s.at)<15000&&!samples.some(x=>x.at===s.at)){const sample={at:s.at,ready:s.jobs.filter(j=>j.ready).length,total:s.jobs.length,dependencies:s.dependencies.every(d=>d.healthy)};samples.push(sample);consecutive=sample.ready===61&&sample.dependencies?consecutive+1:0;if(consecutive===6)break;}await new Promise(r=>setTimeout(r,1000));}
  const report={at:new Date().toISOString(),passed:consecutive===6,jobs:ready.jobs,replays:results.length,samples};await fs.writeFile(dir+'/evidence/activation.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));assert.equal(consecutive,6);
 }
}finally{await db.end();await connection.close();}
