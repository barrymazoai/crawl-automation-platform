import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
const mode=process.argv[2]; assert.ok(['before','after'].includes(mode));
const root='/Users/barry/apps/crawlv3-batch-a.UiA4dx';
const dir=root+'/live/swanson-mainflow-20260910/release-swanson-mainflow-20260910-v2';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const manifest=await read(root+'/live/deployment.json');
const require=createRequire(root+'/package.json');
const pg=require('pg'), {Client,Connection}=require('@temporalio/client');
const db=new pg.Pool({connectionString:manifest.database.connectionString,options:'-c default_transaction_read_only=on',statement_timeout:5000});
const runtime=await read(dir+'/swanson-brand-workflow.runtime.json'),t=runtime.transport;
const connection=await Connection.connect({address:runtime.address,tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
try {
 const client=new Client({connection,namespace:runtime.namespace});
 const active=[];for await(const w of client.workflow.list({query:'ExecutionStatus="Running"'}))active.push(w.workflowId);
 assert.equal(active.length,0,'Active workflow prevents deployment recovery');
 const schedules=[];for await(const s of client.schedule.list()){const d=await client.schedule.getHandle(s.scheduleId).describe();assert.equal(d.state.paused,true);schedules.push({id:s.scheduleId,paused:d.state.paused});}
 const hashes={};for(const table of ['collected_product','review_record','processing_result'])hashes[table]=(await db.query(`SELECT record_hash FROM ${table} ORDER BY record_hash`)).rows.map(r=>r.record_hash);
 const counts={};for(const table of ['collected_product','review_record','processing_result','collection_submission','source_submission_guard'])counts[table]=(await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
 const held=(await db.query('SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL')).rows[0].n;
 assert.equal(held,0);assert.equal(counts.source_submission_guard,0);
 const source=(await db.query('SELECT enabled,revision FROM brand_source WHERE id=$1',['68ff3cbf-3afe-4703-bed7-06104da433d8'])).rows[0];assert.deepEqual(source,{enabled:false,revision:3});
 const status=await read(root+'/status.json');assert.ok(Date.now()-Date.parse(status.at)<15000);
 const report={at:new Date().toISOString(),mode,counts,hashes,held,source,active,schedules,status};
 if(mode==='after'){
  const before=await read(dir+'/evidence/web-recovery-before.json');assert.deepEqual(hashes,before.hashes);assert.deepEqual(counts,before.counts);
  assert.notEqual(status.pid,before.status.pid);assert.equal(status.jobs.length,32);assert.ok(status.jobs.every(j=>j.ready));assert.ok(status.dependencies.every(d=>d.healthy));
  const original=await read(dir+'/original-manifest-before-web-upgrade.json');
  assert.deepEqual(manifest.jobs.filter(j=>j.id!=='brand-web'),original.jobs.filter(j=>j.id!=='brand-web'));
  const strip=m=>({...m,jobs:[]});assert.deepEqual(strip(manifest),strip(original));
  report.originalBusinessWorkersUnchanged=31;report.businessRecordsUnchanged=true;
  const response=await fetch('http://127.0.0.1:4188/v3-live.html?view=dashboard');assert.equal(response.status,200);assert.match(await response.text(),/v3-dataset/);report.webHttpStatus=response.status;
 }
 await fs.writeFile(dir+`/evidence/web-recovery-${mode}.json`,JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify({...report,hashes:undefined}));
}finally{await db.end();await connection.close();}
