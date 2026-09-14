// Read-only progress of the exact purchase-conditions retest. No task submission or recovery.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import pg from 'pg';
import {Client,Connection} from '@temporalio/client';
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',dir='/Users/barry/apps/crawlv3-history-20260913/amazon-purchase-retest-10-20260914';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const started=await read(dir+'/started.json'),plan=await read(dir+'/temporal-plan.json'),r=await read(dir+'/control.runtime.json'),t=r.transport,c=await read(dir+'/amazon.private.json');
assert.equal(plan.productCount,10);const ids=plan.batches.map(b=>b.requestId);assert.equal(ids.length,10);
const connection=await Connection.connect({address:r.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
const db=new pg.Pool({connectionString:c.database.connectionString,max:1,statement_timeout:5000,options:'-c default_transaction_read_only=on'});
try{
 const client=new Client({connection,namespace:r.namespace}),h=client.workflow.getHandle(started.campaignId),state=await h.describe(),p=state.status.name==='COMPLETED'?await h.result():await h.query('progress');
 const old=await client.workflow.getHandle('amazon-history-100-us-10001-20260913').query('progress');assert.equal(old.phase,'paused');assert.equal(old.cursor,24);assert.equal(old.stopAfter,24);
 const submissions=(await db.query('SELECT count(*)::int n FROM collection_submission WHERE request_id=ANY($1::uuid[])',[ids])).rows[0].n;assert.ok(submissions<=10);
 const discoveries=(await db.query('SELECT record FROM catalog_discovery WHERE catalog_id=ANY($1)',[ids])).rows.map(x=>x.record),products=[];
 for(const d of discoveries){
  const ph=client.workflow.getHandle(d.workflowId),s=await ph.describe();
  let child=null;try{const ch=client.workflow.getHandle(d.workflowId+'-label'),cs=await ch.describe();child={status:cs.status.name,pending:cs.raw.pendingActivities?.map(a=>({name:a.activityType?.name,attempt:a.attempt,state:a.state}))??[]};}catch(e){if(e.name!=='WorkflowNotFoundError')throw e;}
  const result=s.status.name==='COMPLETED'?await ph.result():null;
  products.push({asin:d.entry.listingId,workflowId:d.workflowId,status:s.status.name,pending:s.raw.pendingActivities?.map(a=>({name:a.activityType?.name,attempt:a.attempt,state:a.state}))??[],outcome:result?{status:result.status,code:result.code??null}:null,child});
 }
 const captures=(await db.query("SELECT record FROM product_history_source WHERE dataset='v3:amazon' AND record->>'codec'='v3-capture-history/1' AND record->'owner'->>'requestId'=ANY($1)",[ids])).rows.map(({record:v})=>{
  const pc=v.metrics.extras?.purchaseConditions;
  return{asin:v.listing.externalId,observationId:v.observationId,capturedAt:v.capturedAt,price:v.metrics.price,currency:v.metrics.currency,purchaseConditions:pc?{codec:pc.codec,purchaseType:pc.purchaseType,seller:pc.seller,shipsFrom:pc.shipsFrom,delivery:pc.delivery,quantity:pc.quantity,selectedOptions:pc.selectedOptions,subscription:pc.subscription,promotions:pc.promotions,priceScope:pc.priceScope,warnings:pc.warnings}:null};
 });
 const reviews=(await db.query("SELECT record->'observation'->>'listingId' asin,record->'failure'->>'stage' stage,record->'failure'->>'code' code FROM review_record WHERE record->'observation'->>'requestId'=ANY($1)",[ids])).rows;
 const owners=discoveries.flatMap(d=>[d.workflowId,d.workflowId+'-label']);
 const held=(await db.query("SELECT request->>'workflowId' workflow_id,request->'needs' needs FROM resource_permit WHERE released_at IS NULL AND request->>'workflowId'=ANY($1)",[owners])).rows;
 const workers=await read(main+'/status.json'),report={at:new Date().toISOString(),campaignId:started.campaignId,runId:state.runId,status:state.status.name,phase:p.phase,cursor:p.cursor,total:10,stopAfter:p.stopAfter,error:p.error,submissions,products,captures,reviews,held,report:p.report,oldCampaign:{phase:old.phase,cursor:old.cursor,stopAfter:old.stopAfter},workers:{ready:workers.jobs.filter(j=>j.ready).length,total:workers.jobs.length}};
 await fs.writeFile(dir+'/inspection.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
}finally{await db.end();await connection.close();}
