import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {promisify} from 'node:util';import {execFile} from 'node:child_process';import {hostname} from 'node:os';import {createRequire} from 'node:module';
assert.equal(process.argv[2],'--upgrade-resident-controller');assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const root='/Users/barry/apps/crawlv3-batch-a.UiA4dx',dir=root+'/live/channel-resident-20260910-v2',plist='/Users/barry/Library/LaunchAgents/com.crawlv3.batch-a.plist',run=promisify(execFile),read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const tests=await read(dir+'/evidence/controller-tests.json');assert.equal(tests.success,true);assert.equal(tests.numFailedTests,0);
const manifestBytes=await fs.readFile(root+'/live/deployment.json'),manifest=JSON.parse(manifestBytes);assert.equal(manifest.jobs.length,61);
const require=createRequire(root+'/package.json'),pg=require('pg'),db=new pg.Pool({connectionString:manifest.database.connectionString,options:'-c default_transaction_read_only=on',statement_timeout:5000});
const r=await read(dir+'/swanson-brand-workflow.runtime.json'),t=r.transport,{Connection,Client}=require('@temporalio/client'),connection=await Connection.connect({address:r.address,tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
const label=`gui/${process.getuid()}/com.crawlv3.batch-a`,domain=`gui/${process.getuid()}`;
try{
 const client=new Client({connection,namespace:r.namespace});for await(const w of client.workflow.list({query:'ExecutionStatus="Running"'}))throw Error('Active Workflow');
 for(const sql of ['SELECT count(*)::int n FROM source_submission_guard','SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL'])assert.equal((await db.query(sql)).rows[0].n,0);
 const oldPlist=await fs.readFile(plist);await fs.writeFile(dir+'/controller-before.plist',oldPlist,{mode:0o600,flag:'wx'});
 const p=JSON.parse((await run('/usr/bin/plutil',['-convert','json','-o','-',plist])).stdout);assert.equal(p.ProgramArguments[1],root+'/release-channel-resident-20260910-v2/deployment-supervisor.js');p.ProgramArguments[1]=root+'/release-resident-controller-20260910/deployment-supervisor.js';
 await fs.writeFile(dir+'/controller-next.json',JSON.stringify(p),{mode:0o600});await run('/usr/bin/plutil',['-convert','xml1','-o',dir+'/controller-next.plist',dir+'/controller-next.json']);
 await run('/bin/launchctl',['kill','SIGTERM',label]);let stopped=false;for(let i=0;i<160;i++){try{await fs.stat(root+'/supervisor.lock');}catch(e){if(e.code==='ENOENT'){stopped=true;break;}throw e;}await new Promise(r=>setTimeout(r,250));}assert.ok(stopped);
 await run('/bin/launchctl',['bootout',label]);await fs.copyFile(dir+'/controller-next.plist',plist);await run('/bin/launchctl',['bootstrap',domain,plist]);await run('/bin/launchctl',['kickstart',label]);
 assert.deepEqual(await fs.readFile(root+'/live/deployment.json'),manifestBytes);
 const samples=[];let consecutive=0;const until=Date.now()+150000;while(Date.now()<until){try{const s=await read(root+'/status.json');if(Date.now()-Date.parse(s.at)<15000&&!samples.some(x=>x.at===s.at)){
  const sample={at:s.at,pid:s.pid,total:s.jobs.length,ready:s.jobs.filter(j=>j.ready).length,dependencies:s.dependencies.every(d=>d.healthy)};samples.push(sample);consecutive=sample.ready===61&&sample.dependencies?consecutive+1:0;if(consecutive===6)break;
 }}catch{}await new Promise(r=>setTimeout(r,1000));}
 const report={at:new Date().toISOString(),manifestUnchanged:true,samples,consecutiveReady:consecutive,passed:consecutive===6};await fs.writeFile(dir+'/evidence/controller-upgrade.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));assert.equal(consecutive,6);
}finally{await connection.close();await db.end();}
