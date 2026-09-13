// Read-only status for the background 100-product Temporal campaign.
import fs from 'node:fs/promises';import assert from 'node:assert/strict';
import pg from 'pg';import {Client,Connection} from '@temporalio/client';
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',dir='/Users/barry/apps/crawlv3-history-20260913/amazon-100-us-20260913',read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const started=await read(dir+'/started.json'),m=await read(main+'/amazon-pilot-10-20260913/deployment.json'),r=await read(m.jobs.find(j=>j.id==='amazon-batch-workflow').env.V3_WORKER_CONFIG),t=r.transport,c=await read(dir+'/amazon.private.json');
const connection=await Connection.connect({address:r.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}}),db=new pg.Pool({connectionString:c.database.connectionString,max:1,statement_timeout:5000});
try{
 const client=new Client({connection,namespace:r.namespace}),h=client.workflow.getHandle(started.campaignId),s=await h.describe(),p=await h.query('progress');assert.equal(p.totalProducts,100);assert.equal(p.totalChunks,100);
 const current=[];if(p.requestId){const rows=(await db.query('select record from catalog_discovery where catalog_id=$1',[p.requestId])).rows;
  for(const {record:d} of rows){const ph=client.workflow.getHandle(d.workflowId),state=await ph.describe();current.push({asin:d.entry.listingId,workflowId:d.workflowId,status:state.status.name,pending:state.raw.pendingActivities?.map(a=>a.activityType?.name)??[]});}}
 const selected=await read(dir+'/temporal-plan.json'),ids=selected.batches.map(b=>b.requestId);
 const submissions=(await db.query('select count(*)::int n from collection_submission where request_id::text=ANY($1)',[ids])).rows[0].n;
 const captures=(await db.query("select record->'listing'->>'externalId' asin,record->'metrics'->>'price' price,record->'metrics'->>'currency' currency,record->>'capturedAt' captured_at from product_history_source where dataset='v3:amazon' and record->>'codec'='v3-capture-history/1' and record->'owner'->>'requestId'=ANY($1)",[ids])).rows;
 const reviewCount=(await db.query("select count(*)::int n from review_record where record->'observation'->>'requestId'=ANY($1)",[ids])).rows[0].n;
 const status=await read(main+'/status.json'),batchStatus=await read(m.root+'/status.json');
 const report={at:new Date().toISOString(),campaignId:started.campaignId,runId:s.runId,status:s.status.name,phase:p.phase,cursor:p.cursor,total:100,error:p.error,submissions,captures:captures.length,prices:captures.filter(c=>c.price!==null),reviewCount,current,report:p.report,workers:{mainReady:status.jobs.filter(j=>j.ready).length,mainTotal:status.jobs.length,batchReady:batchStatus.jobs.filter(j=>j.ready).length,batchTotal:batchStatus.jobs.length}};
 await fs.writeFile(dir+'/inspection.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
}finally{await db.end();await connection.close();}
