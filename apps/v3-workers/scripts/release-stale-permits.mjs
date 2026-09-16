// Mini, USER-RUN: release permits still held by workflows that have already CLOSED (any resource). A closed
// workflow cannot be running a model, an OCR call or a request any more; the permit only blocks settlement.
// Refuses permits of RUNNING workflows and of closed workflows with an activity still open. Evidence retained.
//   node release-stale-permits.mjs
import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {hostname} from 'node:os';import pg from 'pg';import {Client,Connection} from '@temporalio/client';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',work='/Users/barry/apps/crawlv3-history-20260913/ocr-cloud-20260915',out=work+'/rollout/permit-releases';
const m=JSON.parse(await fs.readFile(main+'/live/deployment.json','utf8'));
const rt=JSON.parse(await fs.readFile(m.jobs.find(j=>j.id==='amazon-catalog-source').env.V3_WORKER_CONFIG,'utf8')),t=rt.transport;
const priv=JSON.parse(await fs.readFile(m.jobs.find(j=>j.id==='amazon-channel-label-ocr-receipts').env.V3_CHANNEL_LABEL_CONFIG,'utf8'));
const connection=await Connection.connect({address:rt.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
const db=new pg.Pool({connectionString:priv.database.connectionString,max:1,statement_timeout:10000});
try{
 const client=new Client({connection,namespace:rt.namespace});await fs.mkdir(out,{recursive:true,mode:0o700});
 const held=(await db.query("SELECT p.permit_id,p.request,p.granted_at,array_agg(n.resource_id) resources FROM resource_permit p JOIN resource_permit_need n USING(permit_id) WHERE p.released_at IS NULL GROUP BY 1,2,3 ORDER BY p.granted_at")).rows;
 const released=[];
 for(const row of held){const {workflowId,runId}=row.request;const handle=client.workflow.getHandle(workflowId,runId);const d=await handle.describe();
  if(d.status.name==='RUNNING'){console.log(JSON.stringify({event:'PERMIT_KEPT',permitId:row.permit_id,workflowId,status:d.status.name}));continue;}
  const hist=await handle.fetchHistory();const scheduled=hist.events.filter(e=>e.activityTaskScheduledEventAttributes).length,ended=hist.events.filter(e=>e.activityTaskCompletedEventAttributes||e.activityTaskFailedEventAttributes||e.activityTaskTimedOutEventAttributes||e.activityTaskCanceledEventAttributes).length;
  if(scheduled!==ended){console.log(JSON.stringify({event:'PERMIT_KEPT',permitId:row.permit_id,workflowId,reason:'open activities',open:scheduled-ended}));continue;}
  const r=await db.query('UPDATE resource_permit SET released_at=coalesce(released_at,now()) WHERE permit_id=$1 AND released_at IS NULL RETURNING released_at',[row.permit_id]);assert.equal(r.rowCount,1);
  const evidence={codec:'stale-permit-release/1',permitId:row.permit_id,resources:row.resources,request:row.request,grantedAt:row.granted_at,workflowType:d.type,workflowStatus:d.status.name,closeTime:d.closeTime,historyEvents:hist.events.length,releasedAt:r.rows[0].released_at,reason:'workflow closed with every activity ended; nothing can still be running under this permit'};
  await fs.writeFile(out+'/'+row.permit_id+'.json',JSON.stringify(evidence,null,2),{flag:'wx',mode:0o600});released.push(row.permit_id);console.log(JSON.stringify({event:'PERMIT_RELEASED',permitId:row.permit_id,resources:row.resources,workflowId,status:d.status.name}));}
 console.log(JSON.stringify({event:'STALE_PERMITS_DONE',held:held.length,released:released.length}));
}finally{await db.end();await connection.close();}
