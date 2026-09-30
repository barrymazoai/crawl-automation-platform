// Mini, fleet RUNNING: raise the R2 timeout in every Amazon private config (label 17, plan 1, amazon 7) to 60s and
// restart those jobs one by one. New config copies are written under work/private/r2-<tag>/; originals untouched.
//   node apply-r2-timeout.mjs <tag> [timeoutMs=60000]
import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {hostname} from 'node:os';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {Client,Connection} from '@temporalio/client';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const tag=process.argv[2],timeoutMs=Number(process.argv[3]??60000);assert.match(tag??'',/^[a-z0-9]{1,12}$/,'usage: apply-r2-timeout.mjs <tag> [timeoutMs]');assert.ok(timeoutMs>=1000&&timeoutMs<=120000);
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',work='/Users/barry/apps/crawlv3-history-20260913/ocr-cloud-20260915',dir=work+'/private/r2-'+tag;
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),run=promisify(execFile);
const manifestPath=main+'/live/deployment.json',text=await fs.readFile(manifestPath,'utf8'),m=JSON.parse(text);
const vars=['V3_CHANNEL_LABEL_CONFIG','V3_AMAZON_LIVE_CONFIG','V3_CHANNEL_PLAN_CONFIG'];
const rt=await read(m.jobs.find(j=>j.id==='amazon-catalog-source').env.V3_WORKER_CONFIG),t=rt.transport;
const connection=await Connection.connect({address:rt.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
try{
 const client=new Client({connection,namespace:rt.namespace});
 for await(const s of client.workflow.list({query:"ExecutionStatus = 'Running'"}))assert.ok(['AmazonHistoryBatchWorkflow','DtcNodeSessionWorkflow'].includes(s.type),'running '+s.type+' '+s.workflowId);
 await fs.mkdir(dir,{recursive:true,mode:0o700});const changed=[],written=new Map();
 for(const j of m.jobs){if(!j.id.startsWith('amazon-'))continue;const v=vars.find(v=>j.env[v]);if(!v)continue;const src=j.env[v];
  let dest=written.get(src);if(!dest){const c=await read(src);assert.ok(c.r2&&typeof c.r2==='object','no r2 block in '+src);dest=dir+'/'+(written.size+1)+'-'+src.split('/').pop();await fs.writeFile(dest,JSON.stringify({...c,r2:{...c.r2,timeoutMs}},null,2),{flag:'wx',mode:0o600});written.set(src,dest);}
  j.env={...j.env,[v]:dest};changed.push(j.id);}
 await fs.writeFile(work+'/rollout/deployment-before-r2-'+tag+'.private.json',text,{flag:'wx',mode:0o600});
 await fs.writeFile(manifestPath+'.r2-'+tag,JSON.stringify(m,null,2),{flag:'wx',mode:0o600});await fs.rename(manifestPath+'.r2-'+tag,manifestPath);
 const controller=main+'/release-independent-control-20260913/independent-deployment/deployment-launchd.js';
 for(const id of changed){const r=await run('/opt/homebrew/bin/node',[controller,'restart',manifestPath,id],{timeout:180000,maxBuffer:1048576});assert.equal(JSON.parse(r.stdout).ready[0].id,id);const h=await read(main+'/'+id+'.health.json');assert.equal(h.event,'WORKER_RUNNING');}
 await fs.writeFile(work+'/rollout/r2-timeout-'+tag+'.json',JSON.stringify({at:new Date().toISOString(),timeoutMs,configs:[...written.entries()],changed},null,2),{flag:'wx',mode:0o600});
 console.log(JSON.stringify({event:'R2_TIMEOUT_APPLIED',tag,timeoutMs,configs:written.size,restarted:changed.length}));
}finally{await connection.close();}
