// Mini, USER-RUN ONLY (this is a deletion): release the source submission guard of a Brand request whose root
// workflow FAILED before any work started. A failed BrandCollectionWorkflow never releases its guard by design
// (temporal-gateway: UNCONFIRMED_TERMINAL), so the source stays SOURCE_BUSY until an operator confirms that
// nothing is running for it. This script confirms that from Temporal + ledger, then removes the one guard row.
//   node release-failed-guard.mjs <requestId>
import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {hostname} from 'node:os';import pg from 'pg';import {Client,Connection} from '@temporalio/client';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const requestId=process.argv[2];assert.match(requestId??'',/^[0-9a-f-]{36}$/,'usage: release-failed-guard.mjs <requestId>');
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',m=JSON.parse(await fs.readFile(main+'/live/deployment.json','utf8'));
const rt=JSON.parse(await fs.readFile(m.jobs.find(j=>j.id==='amazon-catalog-source').env.V3_WORKER_CONFIG,'utf8')),t=rt.transport;
const priv=JSON.parse(await fs.readFile(m.jobs.find(j=>j.id==='amazon-channel-label-ocr-receipts').env.V3_CHANNEL_LABEL_CONFIG,'utf8'));
const connection=await Connection.connect({address:rt.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
const db=new pg.Pool({connectionString:priv.database.connectionString,max:1,statement_timeout:10000});
try{
 const client=new Client({connection,namespace:rt.namespace}),rootId='v3-collection-'+requestId;
 const root=await client.workflow.getHandle(rootId).describe();assert.equal(root.status.name,'FAILED','root must be FAILED, is '+root.status.name);
 let children=0;for await(const e of client.workflow.list({query:`WorkflowId STARTS_WITH '${rootId}-'`}))children++;assert.equal(children,0,'root has descendants');
 const hist=await client.workflow.getHandle(rootId).fetchHistory();const completed=hist.events.filter(e=>e.activityTaskCompletedEventAttributes).length;assert.equal(completed,0,'root completed activities: '+completed);
 assert.equal((await db.query('SELECT count(*)::int n FROM catalog_discovery WHERE catalog_id=$1',[requestId])).rows[0].n,0,'discoveries exist');
 assert.equal((await db.query("SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL AND request->>'workflowId' LIKE $1",[rootId+'%'])).rows[0].n,0,'permits held');
 const guard=(await db.query('SELECT source_id FROM source_submission_guard WHERE request_id=$1',[requestId])).rows;assert.equal(guard.length,1,'guard row count '+guard.length);
 const released=await db.query('DELETE FROM source_submission_guard WHERE request_id=$1 RETURNING source_id',[requestId]);assert.equal(released.rowCount,1);
 console.log(JSON.stringify({event:'FAILED_GUARD_RELEASED',requestId,sourceId:released.rows[0].source_id,rootStatus:root.status.name,failure:hist.events.find(e=>e.workflowExecutionFailedEventAttributes)?.workflowExecutionFailedEventAttributes?.failure?.cause?.message??null}));
}finally{await db.end();await connection.close();}
