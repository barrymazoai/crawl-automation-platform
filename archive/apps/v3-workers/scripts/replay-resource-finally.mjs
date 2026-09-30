// Mini-only read-only history verification. No Activity execution or submission.
import fs from 'node:fs/promises';import {hostname} from 'node:os';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import pg from 'pg';import {Connection,Client} from '@temporalio/client';import {Worker} from '@temporalio/worker';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',work='/Users/barry/apps/crawlv3-history-20260913/resource-finally-20260915',requestId='6f8b4741-a61f-4359-9626-38aeabb2b9bf';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),sha=b=>createHash('sha256').update(b).digest('hex'),m=await read(main+'/live/deployment.json'),j=m.jobs.find(j=>j.id==='amazon-channel-label-ocr'),r=await read(j.env.V3_WORKER_CONFIG),t=r.transport;
const c=await Connection.connect({address:r.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}}),client=new Client({connection:c,namespace:r.namespace}),db=new pg.Pool({connectionString:m.database.connectionString,max:1,statement_timeout:10000,options:'-c default_transaction_read_only=on'});
try{
 await fs.mkdir(work+'/histories',{recursive:true,mode:0o700});
 const ds=(await db.query('SELECT record FROM catalog_discovery WHERE catalog_id=$1',[requestId])).rows.map(x=>x.record);assert.equal(ds.length,10);
 const ids=ds.flatMap(d=>[d.workflowId,d.workflowId+'-label']);ids.push('v3-collection-'+requestId);
 for(const type of ['ChannelSavedLabelWorkflow','GncLeasedProductWorkflow','SwansonCatalogProductWorkflow','DtcCatalogProductV2Workflow','CatalogWorkflow']){
  for await(const row of client.workflow.list({query:`WorkflowType = '${type}' AND ExecutionStatus = 'Completed'`,pageSize:1})){ids.push(row.workflowId);break;}
 }
 const results=[];for(const workflowId of [...new Set(ids)]){
  const h=client.workflow.getHandle(workflowId),d=await h.describe();let history;try{history=await h.fetchHistory();}catch(e){throw Error('History unavailable '+workflowId,{cause:e});}
  await Worker.runReplayHistory({workflowBundle:{codePath:work+'/candidate/workflow/product-workflows.cjs'}},history,workflowId);
  const bytes=Buffer.from(JSON.stringify(history));await fs.writeFile(work+'/histories/'+d.runId+'.json',bytes,{mode:0o600});
  const row={workflowId,runId:d.runId,type:d.type,status:d.status.name,events:history.events.length,sha256:sha(bytes),passed:true};results.push(row);console.log(JSON.stringify(row));
 }
 const proof={at:new Date().toISOString(),passed:true,activityCalls:0,bundleSha256:sha(await fs.readFile(work+'/candidate/workflow/product-workflows.cjs')),results};await fs.writeFile(work+'/replay-results.json',JSON.stringify(proof,null,2),{mode:0o600});
}finally{await db.end();await c.close();}
