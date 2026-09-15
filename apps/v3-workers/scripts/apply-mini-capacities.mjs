// SUPERSEDED by apply-throughput-rollout.mjs (2026-09-15): capacities are now model 14 / cpu 14 / windows-ocr 10 there.
// Mini, fleet STOPPED only: raise resource capacities (model 4, cpu 4, local OCR 4) in the ledger and the
// live manifest, and raise per-process concurrency of the Amazon text/vision workers so 4 model calls can
// actually run. The independent monitor re-owns a resource only when ledger capacity == manifest capacity,
// so both must change together before `start all`. Read-only otherwise; original files retained.
import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {hostname} from 'node:os';import pg from 'pg';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',work='/Users/barry/apps/crawlv3-history-20260913/ocr-cloud-20260915',target={'mini-model-account':4,'mini-cpu':4,'windows-ocr':4};
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),keep=(p,v)=>fs.writeFile(p,typeof v==='string'?v:JSON.stringify(v,null,2),{flag:'wx',mode:0o600});
const manifestPath=main+'/live/deployment.json',text=await fs.readFile(manifestPath,'utf8'),m=JSON.parse(text),status=await read(main+'/status.json');
assert.ok(status.status==='monitor-stopped'||status.jobs.every(j=>!j.ready),'fleet must be stopped');
const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const run=promisify(execFile);
assert.equal((await run('/bin/launchctl',['list'])).stdout.split('\n').filter(l=>l.includes('com.crawlv3')).length,0,'launchd services still loaded');
const ocrPrivate=await read(m.jobs.find(j=>j.id==='amazon-channel-label-ocr-receipts').env.V3_CHANNEL_LABEL_CONFIG);
const db=new pg.Pool({connectionString:ocrPrivate.database.connectionString,max:1,statement_timeout:5000});
try{
 await fs.mkdir(work+'/capacity',{recursive:true,mode:0o700});await keep(work+'/capacity/deployment-before.private.json',text);
 const before=(await db.query('SELECT resource_id,capacity,controller FROM resource_capacity WHERE resource_id=ANY($1)',[Object.keys(target)])).rows;await keep(work+'/capacity/ledger-before.json',before);
 assert.equal((await db.query('SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL')).rows[0].n,0,'held permits');
 for(const [id,cap] of Object.entries(target)){const r=await db.query('UPDATE resource_capacity SET capacity=$2,controller=NULL,healthy=false,health_until=now(),reason=$3 WHERE resource_id=$1 RETURNING resource_id',[id,cap,'capacity_change_'+cap]);assert.equal(r.rowCount,1,id);}
 const after=structuredClone(m);for(const r of after.resources)if(target[r.resourceId]!==undefined)r.capacity=target[r.resourceId];
 // Per-process concurrency: the ledger caps the total; each Amazon model process must be able to hold its share.
 for(const id of ['amazon-channel-label-text','amazon-channel-label-vision']){const j=after.jobs.find(j=>j.id===id);assert.ok(j,id);const rt=await read(j.env.V3_WORKER_CONFIG);
  const next={...rt,concurrency:4};j.env={...j.env,V3_WORKER_CONFIG:work+'/capacity/'+id+'.runtime.json'};await keep(j.env.V3_WORKER_CONFIG,next);}
 await keep(work+'/capacity/deployment-after.private.json',after);await keep(manifestPath+'.capacity-next',after);await fs.rename(manifestPath+'.capacity-next',manifestPath);
 const ledger=(await db.query('SELECT resource_id,capacity,controller FROM resource_capacity WHERE resource_id=ANY($1)',[Object.keys(target)])).rows;
 await keep(work+'/capacity/receipt.json',{at:new Date().toISOString(),target,ledgerBefore:before,ledgerAfter:ledger,manifestResources:after.resources.map(r=>({id:r.resourceId,capacity:r.capacity}))});
 console.log(JSON.stringify({event:'MINI_CAPACITY_APPLIED',ledger,concurrency:{'amazon-channel-label-text':4,'amazon-channel-label-vision':4}}));
}finally{await db.end();}
