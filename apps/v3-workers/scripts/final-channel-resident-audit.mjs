import fs from'node:fs/promises';import assert from'node:assert/strict';import{createRequire}from'node:module';import{hostname}from'node:os';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const root='/Users/barry/apps/crawlv3-batch-a.UiA4dx',dir=root+'/live/channel-resident-20260910-v2',read=async p=>JSON.parse(await fs.readFile(p)),manifest=await read(root+'/live/deployment.json');
const ids=['d276df76-d9ab-4432-b2eb-eee59d4082f4','8d8a948c-e9c7-4aeb-872d-e507db25cae7','0209d445-78fd-4bf0-8d6f-0415e340cc38'];
const require=createRequire(root+'/package.json'),pg=require('pg'),{Client,Connection}=require('@temporalio/client');
const r=await read(dir+'/swanson-brand-workflow.runtime.json'),t=r.transport,connection=await Connection.connect({address:r.address,tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
const db=new pg.Pool({connectionString:manifest.database.connectionString,options:'-c default_transaction_read_only=on',statement_timeout:5000});
try{
 const client=new Client({connection,namespace:r.namespace});for await(const w of client.workflow.list({query:'ExecutionStatus="Running"'}))throw Error('Running workflow remains');
 const schedules=[];for await(const s of client.schedule.list()){const d=await client.schedule.getHandle(s.scheduleId).describe();assert.equal(d.state.paused,true);schedules.push({id:s.scheduleId,paused:d.state.paused});}
 const counts={};for(const table of ['collected_product','review_record','processing_result','collection_submission','source_submission_guard','resource_permit'])counts[table]=(await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
 assert.equal(counts.source_submission_guard,0);const held=(await db.query('SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL')).rows[0].n;assert.equal(held,0);
 const expected=await read(dir+'/baseline.json'),requests=[];
 for(const id of ids){const report=await read(dir+'/evidence/request-'+id+'/report.json'),records=await read(dir+'/evidence/request-'+id+'/records.json');assert.ok(report.workflows.every(w=>w.status==='COMPLETED'));assert.equal(report.held,0);assert.equal(report.oldRecordsPreserved,true);assert.ok(report.artifacts.every(a=>a.verified));
  for(const [table,rows]of Object.entries(records.rows))expected.hashes[table].push(...rows.map(row=>row.record_hash));requests.push({requestId:id,counts:report.counts,artifacts:report.artifacts.length});
 }
 for(const [table,hashes]of Object.entries(expected.hashes)){const current=new Set((await db.query(`SELECT record_hash FROM ${table}`)).rows.map(r=>r.record_hash));for(const hash of hashes)assert.ok(current.has(hash));}
 const s=await read(root+'/status.json');assert.ok(Date.now()-Date.parse(s.at)<15000);assert.equal(s.jobs.length,61);assert.ok(s.jobs.every(j=>j.ready));assert.ok(s.dependencies.every(d=>d.healthy));
 const sources=(await db.query('SELECT id,channel,enabled,revision FROM brand_source ORDER BY id')).rows;
 const journals=[];for(const label of ['browser-pages','gnc-browser-pages']){for(const file of (await fs.readdir(dir+'/'+label,{recursive:true})).filter(f=>f.endsWith('/opened.json'))){const opened=await read(dir+'/'+label+'/'+file),closed=await read(dir+'/'+label+'/'+file.replace('/opened.json','/closed.json'));assert.deepEqual(closed,opened);journals.push({channel:label,taskId:opened.taskId,targetId:opened.targetId,closed:true});}}
 const result={passed:true,at:new Date().toISOString(),counts,held,ready:61,dependencies:s.dependencies.map(d=>({id:d.id,healthy:d.healthy})),sources,schedules,requests,allOldAndNewHashesPreserved:true,journals};
 await fs.writeFile(dir+'/evidence/final-audit.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await db.end();await connection.close();}
