/** Mini composition only: prepares immutable configs; never starts or submits work. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { createHash,randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
assert.equal(process.argv[2],'--prepare-channel-resident');assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const root='/Users/barry/apps/crawlv3-batch-a.UiA4dx',name=process.argv[3]??'channel-resident-20260910';assert.match(name,/^channel-resident-20260910(?:-v[2-9])?$/);
const dir=root+'/live/'+name,release=root+'/release-'+name;await fs.mkdir(dir,{recursive:true,mode:0o700});await fs.mkdir(dir+'/evidence',{recursive:true,mode:0o700});
const oldDir=root+'/live/swanson-mainflow-20260910/release-swanson-mainflow-20260910-v2';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
async function retain(name,v){const p=dir+'/'+name,b=JSON.stringify(v,null,2);try{await fs.writeFile(p,b,{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;assert.equal(await fs.readFile(p,'utf8'),b);}return p;}
const original=await read(root+'/live/deployment.json');assert.equal(original.jobs.length,32);
const old=await read(oldDir+'/ready.json'),swManifest=await read(oldDir+'/deployment.json');
let intent;try{intent=await read(dir+'/intent.json');}catch(e){if(e.code!=='ENOENT')throw e;intent={id:randomUUID(),enableRequest:randomUUID(),requestId:randomUUID()};await retain('intent.json',intent);}
const require=createRequire(root+'/package.json'),pg=require('pg');
const db=new pg.Pool({connectionString:original.database.connectionString,options:'-c default_transaction_read_only=on',statement_timeout:5000});
try{
 for(const sql of ['SELECT count(*)::int n FROM source_submission_guard','SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL'])assert.equal((await db.query(sql)).rows[0].n,0);
 const source=(await db.query('SELECT enabled,revision FROM brand_source WHERE id=$1',[old.scope.sourceId])).rows[0];assert.deepEqual(source,{enabled:false,revision:3});
 const hashes={};for(const t of ['collected_product','review_record','processing_result'])hashes[t]=(await db.query(`SELECT record_hash FROM ${t} ORDER BY record_hash`)).rows.map(r=>r.record_hash);
 await retain('baseline.json',{hashes,submissions:(await db.query('SELECT count(*)::int n FROM collection_submission')).rows[0].n});
}finally{await db.end();}
const code=(await fs.readdir(release)).filter(n=>n.endsWith('.js')).sort();
async function hash(names){const h=createHash('sha256');for(const n of names){const b=await fs.readFile(release+'/'+n);h.update(String(b.length));h.update(':');h.update(b);}return h.digest('hex');}
const activityBuild=await hash(code),workflowBuild=await hash([...code,'product-workflows.cjs'].sort());
const queueScope='swanson-acg-resident-v1',prefix='crawlv3-acceptance/swanson-resident-'+intent.id;
const remap=v=>JSON.parse(JSON.stringify(v).replaceAll(oldDir,dir).replaceAll(old.queueScope,queueScope).replaceAll(old.r2Prefix,prefix));
const sw=remap(await read(oldDir+'/swanson.private.json'));sw.scope.scopeVersion='source-revision-4';sw.maxPages=10;
await retain('swanson.private.json',sw);await retain('plan.private.json',remap(await read(oldDir+'/plan.private.json')));
const label=remap(await read(oldDir+'/label.private.json'));
const added=[];
for(const previous of swManifest.jobs.filter(j=>j.id!=='brand-web')){
 const j=structuredClone(previous),runtime=remap(await read(j.env.V3_WORKER_CONFIG));runtime.expectedBuildId=j.entry.endsWith('/product-workflow-worker.js')?workflowBuild:activityBuild;
 runtime.hostId='mini-'+runtime.role;j.entry=release+'/'+path.basename(j.entry);j.env.V3_WORKER_CONFIG=await retain(runtime.role+'.runtime.json',runtime);
 for(const key of Object.keys(j.env))if(key.endsWith('_CONFIG')&&key!=='V3_WORKER_CONFIG')j.env[key]=j.env[key].replace(oldDir,dir);
 if(j.env.V3_CHANNEL_LABEL_CONFIG){const role=runtime.role.replace('channel-label-',''),c=structuredClone(label);if(!['text','vision'].includes(role))delete c.codex;if(role!=='ocr')delete c.ocrProvider;
  j.env.V3_CHANNEL_LABEL_CONFIG=await retain('label-'+role+'.private.json',c);}
 if(j.id==='catalog-workflow')j.id='swanson-catalog-workflow';added.push(j);
}
const jobs=structuredClone(original.jobs),upgraded=[];
for(const j of jobs){
 const file=path.basename(j.entry);
 if(!['live-gnc-worker.js','brand-pipeline-worker.js','product-workflow-worker.js','brand-web.js'].includes(file))continue;
 j.entry=release+'/'+file;upgraded.push(j.id);
 if(j.env.V3_WORKER_CONFIG){const r=await read(j.env.V3_WORKER_CONFIG);r.expectedBuildId=file==='product-workflow-worker.js'?workflowBuild:activityBuild;j.env.V3_WORKER_CONFIG=await retain('existing-'+j.id+'.runtime.json',r);}
 for(const key of ['V3_LIVE_GNC_CONFIG','V3_BRAND_PIPELINE_CONFIG'])if(j.env[key]){const c=await read(j.env[key]);c.pageJournalRoot??=dir+'/gnc-browser-pages';await fs.mkdir(c.pageJournalRoot,{recursive:true,mode:0o700});j.env[key]=await retain('existing-'+j.id+'.private.json',c);}
 if(j.id==='brand-web'){const c=await read(j.env.V3_BRAND_WEB_CONFIG);c.delivery.channelTargets={...c.delivery.channelTargets,swanson:remap(old.target)};j.env.V3_BRAND_WEB_CONFIG=await retain('web.private.json',c);}
}
const resources=original.resources.map(r=>({...r,jobs:[...new Set([...r.jobs,...swManifest.resources.find(x=>x.resourceId===r.resourceId).jobs])]}));
const dependencyProbes=original.dependencyProbes.map(p=>p.kind==='handoff-backlog'?{...p,roots:[...p.roots,...remap(swManifest.dependencyProbes.find(x=>x.id===p.id)).roots]}:p);
for(const p of dependencyProbes)if(p.kind==='handoff-backlog')for(const r of p.roots)await fs.mkdir(r.root,{recursive:true,mode:0o700});
const manifest={...original,jobs:[...jobs,...added],resources,dependencyProbes};assert.equal(manifest.jobs.length,61);assert.equal(new Set(manifest.jobs.map(j=>j.id)).size,61);
await retain('previous-deployment.json',original);await retain('deployment.json',manifest);
await fs.copyFile('/Users/barry/Library/LaunchAgents/com.crawlv3.batch-a.plist',dir+'/previous-launchagent.plist',fs.constants.COPYFILE_EXCL);
await retain('ready.json',{root,dir,release,queueScope,scope:sw.scope,sourceRevision:4,target:remap(old.target),activityBuild,workflowBuild,requestId:intent.requestId,enableRequest:intent.enableRequest,r2Prefix:prefix,workers:61,upgraded,added:added.map(j=>j.id)});
console.log(JSON.stringify({prepared:true,workers:61,upgraded,added:added.length,sourceEnabled:false,dir,release}));
