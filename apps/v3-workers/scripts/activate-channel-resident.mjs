/** Drained, evidence-gated Mini activation with rollback; never enables sources or submits work. */
import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {hostname} from 'node:os';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';
assert.equal(process.argv[2],'--activate-reviewed-channel-resident');assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const dir=process.argv[3],root='/Users/barry/apps/crawlv3-batch-a.UiA4dx';assert.match(dir??'',/^\/Users\/barry\/apps\/crawlv3-batch-a\.UiA4dx\/live\/channel-resident-20260910-v[2-9]$/);
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),run=promisify(execFile),ready=await read(dir+'/ready.json'),next=await read(dir+'/deployment.json'),previous=await read(dir+'/previous-deployment.json');
assert.deepEqual(await read(root+'/live/deployment.json'),previous);assert.equal(next.jobs.length,61);
const tests=await read(dir+'/evidence/tests.json'),preflight=await read(dir+'/evidence/role-preflight.json'),replay=await read(dir+'/evidence/replay.json');
assert.equal(tests.numFailedTests,0);assert.equal(tests.success,true);assert.equal(preflight.results.length,20);assert.ok(preflight.results.every(r=>r.passed));assert.ok(replay.results.length>=10&&replay.results.every(r=>r.replay==='passed'));
const files=(await fs.readdir(ready.release)).filter(n=>n.endsWith('.js')).sort();const h=createHash('sha256');for(const n of files){const b=await fs.readFile(ready.release+'/'+n);h.update(String(b.length));h.update(':');h.update(b);}assert.equal(h.digest('hex'),ready.activityBuild);
const require=createRequire(root+'/package.json'),pg=require('pg'),{Client,Connection}=require('@temporalio/client');
const db=new pg.Pool({connectionString:previous.database.connectionString,options:'-c default_transaction_read_only=on',statement_timeout:5000});
const runtime=await read(dir+'/swanson-brand-workflow.runtime.json'),t=runtime.transport,connection=await Connection.connect({address:runtime.address,tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
const label=`gui/${process.getuid()}/com.crawlv3.batch-a`,domain=`gui/${process.getuid()}`,plist='/Users/barry/Library/LaunchAgents/com.crawlv3.batch-a.plist';
const report={at:new Date().toISOString(),status:'preflight',workers:61,sourceEnabled:false};let stopped=false,replaced=false;
async function empty(){const client=new Client({connection,namespace:runtime.namespace});for await(const w of client.workflow.list({query:'ExecutionStatus="Running"'}))throw Error('Active Workflow: '+w.workflowId);
 for await(const s of client.schedule.list())assert.equal((await client.schedule.getHandle(s.scheduleId).describe()).state.paused,true);
 for(const sql of ['SELECT count(*)::int n FROM source_submission_guard','SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL'])assert.equal((await db.query(sql)).rows[0].n,0);
 assert.deepEqual((await db.query('SELECT enabled,revision FROM brand_source WHERE id=$1',[ready.scope.sourceId])).rows[0],{enabled:false,revision:3});}
async function stop(){await run('/bin/launchctl',['kill','SIGTERM',label]);for(let i=0;i<160;i++){try{await fs.stat(root+'/supervisor.lock');}catch(e){if(e.code==='ENOENT')return;throw e;}await new Promise(r=>setTimeout(r,250));}throw Error('STOP_UNVERIFIED');}
async function install(manifest,plistBytes){await run('/bin/launchctl',['bootout',label]);await fs.writeFile(root+'/live/deployment.json.next',JSON.stringify(manifest),{mode:0o600,flag:'wx'});await fs.rename(root+'/live/deployment.json.next',root+'/live/deployment.json');await fs.writeFile(plist,plistBytes,{mode:0o600});await run('/bin/launchctl',['bootstrap',domain,plist]);await run('/bin/launchctl',['kickstart',label]);}
try{
 await empty();
 const baseline=await read(dir+'/baseline.json');for(const [table,hashes] of Object.entries(baseline.hashes))assert.deepEqual((await db.query(`SELECT record_hash FROM ${table} ORDER BY record_hash`)).rows.map(r=>r.record_hash),hashes);
 assert.equal((await db.query('SELECT count(*)::int n FROM collection_submission')).rows[0].n,baseline.submissions);
 const plistRead=await run('/usr/bin/plutil',['-convert','json','-o','-',plist]),p=JSON.parse(plistRead.stdout);assert.equal(p.Label,'com.crawlv3.batch-a');assert.equal(p.KeepAlive,false);assert.equal(p.ProgramArguments.length,3);assert.equal(p.ProgramArguments[2],root+'/live/deployment.json');
 p.ProgramArguments[1]=ready.release+'/deployment-supervisor.js';const candidate=dir+'/next-launchagent.json';await fs.writeFile(candidate,JSON.stringify(p),{mode:0o600});await run('/usr/bin/plutil',['-convert','xml1','-o',dir+'/next-launchagent.plist',candidate]);
 await stop();stopped=true;await empty();replaced=true;await install(next,await fs.readFile(dir+'/next-launchagent.plist'));
 let status;const until=Date.now()+150000;while(Date.now()<until){try{status=await read(root+'/status.json');if(Date.now()-Date.parse(status.at)<15000&&status.jobs.length===61&&status.jobs.every(j=>j.ready)&&status.dependencies.every(d=>d.healthy))break;}catch{}await new Promise(r=>setTimeout(r,1000));}
 assert.equal(status?.jobs.length,61);assert.ok(status.jobs.every(j=>j.ready));assert.ok(status.dependencies.every(d=>d.healthy));
 const response=await fetch('http://127.0.0.1:4188/v3-live.html?view=dashboard');assert.equal(response.status,200);await empty();
 for(const [table,hashes] of Object.entries(baseline.hashes))assert.deepEqual((await db.query(`SELECT record_hash FROM ${table} ORDER BY record_hash`)).rows.map(r=>r.record_hash),hashes);
 Object.assign(report,{status:'ready',runtime:status,webHttp:response.status,businessRecordsUnchanged:true});
}catch(error){report.error=error.message;report.status='failed';
 if(replaced){await empty();await stop();await install(previous,await fs.readFile(dir+'/previous-launchagent.plist'));report.status='rolled-back';}
 else if(stopped){await run('/bin/launchctl',['kickstart',label]);report.status='previous-restarted';}
 process.exitCode=1;
}finally{await fs.writeFile(dir+'/evidence/activation.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));await connection.close();await db.end();}
