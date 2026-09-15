// Mini, fleet RUNNING: rebind the whole Amazon set (label 17, plan 1, amazon 7, workflow 4) to the current candidate
// builds and restart them one by one through the independent controller. Also writes a new Amazon private config
// with `productResources.releaseOnReview: true` (request lane). Refuses while any business workflow other than the
// batch campaigns / DTC node is running, and requires the replay receipt to match the candidate workflow bundle.
// If the Amazon jobs are still bound to a test copy (batch-*/amazon.private.json), the canonical config is taken
// from that test's retained deployment-before manifest. Everything is retained; the manifest swap is atomic.
//   node rebind-amazon-live.mjs <tag>      e.g. r3
import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {hostname} from 'node:os';import {createHash} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {Client,Connection} from '@temporalio/client';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const tag=process.argv[2];assert.match(tag??'',/^[a-z0-9]{1,12}$/,'usage: rebind-amazon-live.mjs <tag> [groups: label,plan,amazon,workflow]');
const selected=(process.argv[3]??'label,plan,amazon,workflow').split(',');
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',work='/Users/barry/apps/crawlv3-history-20260913/ocr-cloud-20260915',candidate=work+'/candidate',release=main+'/release-throughput-20260915',runtimeDir=work+'/runtime-throughput-'+tag;
const amazonJobs=['amazon-control','amazon-catalog-source','amazon-catalog-ledger','amazon-product-input','amazon-capture','amazon-file','amazon-review'];
const workflowJobs=['amazon-product-workflow','amazon-catalog-workflow','amazon-brand-workflow','amazon-channel-label-workflow'];
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),run=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
const replay=await read(work+'/replay-results.json');assert.equal(replay.passed,true);assert.equal(replay.bundleSha256,sha(await fs.readFile(candidate+'/workflow/product-workflows.cjs')),'replay receipt must match the candidate bundle');
const {AmazonLiveConfigSchema}=await import(candidate+'/amazon-config/amazon-live-config.js');
const manifestPath=main+'/live/deployment.json',text=await fs.readFile(manifestPath,'utf8'),m=JSON.parse(text);
const labelJobs=m.jobs.filter(j=>j.id.startsWith('amazon-channel-label-')&&!workflowJobs.includes(j.id)).map(j=>j.id);assert.equal(labelJobs.length,17,'label jobs '+labelJobs.length);
const allGroups={label:{files:['channel-label-worker.js'],jobs:labelJobs},plan:{files:['channel-plan-worker.js'],jobs:['amazon-channel-product-input']},amazon:{files:['amazon-live-worker.js'],jobs:amazonJobs},workflow:{files:['product-workflow-worker.js','product-workflows.cjs'],jobs:workflowJobs}};
for(const g of selected)assert.ok(allGroups[g],'unknown group '+g);const groups=Object.fromEntries(selected.map(g=>[g,allGroups[g]]));
const rt=await read(m.jobs.find(j=>j.id==='amazon-catalog-source').env.V3_WORKER_CONFIG),t=rt.transport;
const connection=await Connection.connect({address:rt.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:await fs.readFile(t.caFile),clientCertPair:{crt:await fs.readFile(t.certFile),key:await fs.readFile(t.keyFile)}}});
try{
 const client=new Client({connection,namespace:rt.namespace});
 for await(const s of client.workflow.list({query:"ExecutionStatus = 'Running'"}))assert.ok(['AmazonHistoryBatchWorkflow','DtcNodeSessionWorkflow'].includes(s.type),'running '+s.type+' '+s.workflowId);
 let currentPath=m.jobs.find(j=>j.id==='amazon-capture').env.V3_AMAZON_LIVE_CONFIG;
 if(currentPath.includes('/batch-')){const before=await read(currentPath.replace(/\/amazon\.private\.json$/,'/deployment-before.private.json'));currentPath=before.jobs.find(j=>j.id==='amazon-capture').env.V3_AMAZON_LIVE_CONFIG;assert.ok(!currentPath.includes('/batch-'),'canonical config unresolved');}
 const current=await read(currentPath),amazon=AmazonLiveConfigSchema.parse({...current,productResources:{...current.productResources,releaseOnReview:true},...(current.capture?.mode==='scraperapi'?{capture:{...current.capture,dns:'doh'}}:{})});
 const privatePath=work+'/private/amazon-scraperapi-'+tag+'.private.json';await fs.writeFile(privatePath,JSON.stringify(amazon,null,2),{flag:'wx',mode:0o600});
 await fs.mkdir(runtimeDir,{recursive:true,mode:0o700});const builds={},before=[];
 for(const [group,g] of Object.entries(groups)){
  const dest=release+'/'+group+'-'+tag;await fs.mkdir(dest,{recursive:true,mode:0o700});const h=createHash('sha256');
  for(const n of [...g.files].sort()){const b=await fs.readFile(candidate+'/'+group+'/'+n);await fs.writeFile(dest+'/'+n,b,{flag:'wx',mode:0o600});h.update(String(b.length)+':').update(b);}
  builds[group]={dest,entry:dest+'/'+g.files[0],buildId:h.digest('hex')};
  for(const id of g.jobs){const j=m.jobs.find(j=>j.id===id);assert.ok(j,id);before.push({id,entry:j.entry,runtime:j.env.V3_WORKER_CONFIG,config:j.env.V3_AMAZON_LIVE_CONFIG??null});const old=await read(j.env.V3_WORKER_CONFIG);
   j.entry=builds[group].entry;j.env={...j.env,V3_WORKER_CONFIG:runtimeDir+'/'+id+'.json',...(group==='amazon'?{V3_AMAZON_LIVE_CONFIG:privatePath}:{})};
   await fs.writeFile(j.env.V3_WORKER_CONFIG,JSON.stringify({...old,expectedBuildId:builds[group].buildId},null,2),{flag:'wx',mode:0o600});}
 }
 await fs.writeFile(work+'/rollout/deployment-before-'+tag+'.private.json',text,{flag:'wx',mode:0o600});
 await fs.writeFile(manifestPath+'.'+tag,JSON.stringify(m,null,2),{flag:'wx',mode:0o600});await fs.rename(manifestPath+'.'+tag,manifestPath);
 const controller=main+'/release-independent-control-20260913/independent-deployment/deployment-launchd.js',restarted=[];
 // Consumers of the new contract first (label, plan), then workflow workers, then the Amazon roles that produce it.
 for(const group of ['label','plan','workflow','amazon'].filter(g=>groups[g]))for(const id of groups[group].jobs){
  const r=await run('/opt/homebrew/bin/node',[controller,'restart',manifestPath,id],{timeout:180000,maxBuffer:1048576});assert.equal(JSON.parse(r.stdout).ready[0].id,id);
  const h=await read(main+'/'+id+'.health.json');assert.equal(h.event,'WORKER_RUNNING');assert.equal(h.buildId,builds[group].buildId,'build '+id);restarted.push({id,group,pid:h.pid});}
 await fs.writeFile(work+'/rollout/rebind-'+tag+'.json',JSON.stringify({at:new Date().toISOString(),builds,privatePath,before,restarted,replay:replay.bundleSha256},null,2),{flag:'wx',mode:0o600});
 console.log(JSON.stringify({event:'AMAZON_REBOUND',tag,groups:selected,dns:amazon.capture.dns??null,builds:Object.fromEntries(Object.entries(builds).map(([g,b])=>[g,b.buildId])),restarted:restarted.length,releaseOnReview:amazon.productResources.releaseOnReview}));
}finally{await connection.close();}
