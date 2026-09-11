// Read-only Mini audit of this bounded proof; does not replay business work.
import fs from 'node:fs/promises';import assert from 'node:assert/strict';import{createRequire}from'node:module';import{hostname}from'node:os';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const root='/Users/barry/apps/crawlv3-batch-a.UiA4dx',id='swanson-coverage-2df9dfc1-33de-413b-93fa-4531a4428311',dir=root+'/live/'+id,read=async p=>JSON.parse(await fs.readFile(p));
const generation=process.argv[2]??'label';assert.match(generation,/^label(?:-[0-9]{8})?$/);
const require=createRequire(root+'/package.json'),pg=require('pg'),{Client,Connection}=require('@temporalio/client'),manifest=await read(root+'/live/deployment.json');
const r=await read(root+'/live/channel-resident-20260910-v2/swanson-brand-workflow.runtime.json'),t=r.transport;
const connection=await Connection.connect({address:r.address,tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
const db=new pg.Pool({connectionString:manifest.database.connectionString,options:'-c default_transaction_read_only=on',statement_timeout:5000});
try{
 const client=new Client({connection,namespace:r.namespace}),workflows=[];
 for(const variant of ['46318812266634','46318811709578']){const h=client.workflow.getHandle(id+'-'+generation+'-'+variant),d=await h.describe(),history=await h.fetchHistory(),activities={};for(const e of history.events??[]){const name=e.activityTaskScheduledEventAttributes?.activityType?.name;if(name)activities[name]=(activities[name]??0)+1;}workflows.push({workflowId:d.workflowId,status:d.status.name,activities,pending:d.raw.pendingActivities?.map(a=>({type:a.activityType?.name,state:a.state,attempt:a.attempt,lastFailure:a.lastFailure?.message})),...(d.status.name==='COMPLETED'?{result:await h.result()}:{})});}
 const counts={};for(const table of ['collected_product','review_record','processing_result','collection_submission','source_submission_guard'])counts[table]=(await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
 const held=(await db.query('SELECT permit_id,request FROM resource_permit WHERE released_at IS NULL')).rows;
 const newReviews=(await db.query('SELECT record FROM review_record WHERE record::text LIKE $1',['%'+id+'%'])).rows.map(r=>({failure:r.record.failure,observation:r.record.observation}));
 const baseline=await read(dir+'/'+generation+'/baseline.json');for(const[table,hashes]of Object.entries(baseline)){const now=new Set((await db.query(`SELECT record_hash FROM ${table}`)).rows.map(r=>r.record_hash));assert.ok(hashes.every(h=>now.has(h)));}
 const s=await read(root+'/status.json'),active=[];for await(const w of client.workflow.list({query:'ExecutionStatus="Running"'}))active.push({id:w.workflowId,type:w.type});
 const schedules=[];for await(const s of client.schedule.list()){const d=await client.schedule.getHandle(s.scheduleId).describe();schedules.push({id:s.scheduleId,paused:d.state.paused});}
 const sources=(await db.query('SELECT id,channel,enabled,revision FROM brand_source ORDER BY id')).rows;
 const report={at:new Date().toISOString(),workflows,counts,held,newReviews,oldHashesPreserved:true,ready:s.jobs.filter(j=>j.ready).length,total:s.jobs.length,dependencies:s.dependencies.map(d=>({id:d.id,healthy:d.healthy})),active,schedules,sources};
 await fs.writeFile(dir+'/'+generation+'/audit.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await db.end();await connection.close();}
