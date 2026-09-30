// Mini, fleet RUNNING: raise per-process concurrency of the Amazon set (new runtime files, same builds/configs)
// and restart the changed jobs one by one through the independent controller. Model-bound roles keep the agreed
// values (text 4, vision 4, ocr 4); every other role is I/O-bound (Temporal round trips + R2/DB) and was 1.
//   node apply-amazon-concurrency.mjs <tag>
import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {hostname} from 'node:os';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {Client,Connection} from '@temporalio/client';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const tag=process.argv[2];assert.match(tag??'',/^[a-z0-9]{1,12}$/,'usage: apply-amazon-concurrency.mjs <tag>');
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',work='/Users/barry/apps/crawlv3-history-20260913/ocr-cloud-20260915',runtimeDir=work+'/runtime-concurrency-'+tag;
const target={'amazon-channel-label-plan':8,'amazon-channel-label-page':8,'amazon-channel-label-page-text':8,'amazon-channel-label-image-prepare':8,'amazon-channel-label-ocr-receipts':8,'amazon-channel-label-keywords':8,
 'amazon-channel-label-source':8,'amazon-channel-label-manifest':8,'amazon-channel-label-text-receipts':8,'amazon-channel-label-core':8,'amazon-channel-label-assembly':8,'amazon-channel-label-review':8,'amazon-channel-label-resources':8,
 'amazon-channel-label-collection':4,'amazon-control':2,'amazon-catalog-source':4,'amazon-catalog-ledger':4,'amazon-product-input':4,'amazon-capture':8,'amazon-file':8,'amazon-review':4,'amazon-channel-product-input':4,
 'amazon-brand-workflow':8,'amazon-product-workflow':8,'amazon-catalog-workflow':8,'amazon-channel-label-workflow':8};
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),run=promisify(execFile);
const manifestPath=main+'/live/deployment.json',text=await fs.readFile(manifestPath,'utf8'),m=JSON.parse(text);
const rt=await read(m.jobs.find(j=>j.id==='amazon-catalog-source').env.V3_WORKER_CONFIG),t=rt.transport;
const connection=await Connection.connect({address:rt.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
try{
 const client=new Client({connection,namespace:rt.namespace});
 for await(const s of client.workflow.list({query:"ExecutionStatus = 'Running'"}))assert.ok(['AmazonHistoryBatchWorkflow','DtcNodeSessionWorkflow'].includes(s.type),'running '+s.type+' '+s.workflowId);
 await fs.mkdir(runtimeDir,{recursive:true,mode:0o700});const changed=[];
 for(const [id,concurrency] of Object.entries(target)){const j=m.jobs.find(j=>j.id===id);assert.ok(j,id);const old=await read(j.env.V3_WORKER_CONFIG);if(old.concurrency===concurrency)continue;
  j.env={...j.env,V3_WORKER_CONFIG:runtimeDir+'/'+id+'.json'};await fs.writeFile(j.env.V3_WORKER_CONFIG,JSON.stringify({...old,concurrency},null,2),{flag:'wx',mode:0o600});changed.push({id,from:old.concurrency,to:concurrency});}
 await fs.writeFile(work+'/rollout/deployment-before-concurrency-'+tag+'.private.json',text,{flag:'wx',mode:0o600});
 await fs.writeFile(manifestPath+'.concurrency-'+tag,JSON.stringify(m,null,2),{flag:'wx',mode:0o600});await fs.rename(manifestPath+'.concurrency-'+tag,manifestPath);
 const controller=main+'/release-independent-control-20260913/independent-deployment/deployment-launchd.js';
 for(const c of changed){const r=await run('/opt/homebrew/bin/node',[controller,'restart',manifestPath,c.id],{timeout:180000,maxBuffer:1048576});assert.equal(JSON.parse(r.stdout).ready[0].id,c.id);const h=await read(main+'/'+c.id+'.health.json');assert.equal(h.event,'WORKER_RUNNING');c.pid=h.pid;}
 await fs.writeFile(work+'/rollout/concurrency-'+tag+'.json',JSON.stringify({at:new Date().toISOString(),changed},null,2),{flag:'wx',mode:0o600});
 console.log(JSON.stringify({event:'AMAZON_CONCURRENCY_APPLIED',tag,changed:changed.map(c=>c.id+':'+c.from+'>'+c.to)}));
}finally{await connection.close();}
