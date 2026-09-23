// Manually activate the verified candidate for the current Amazon campaign.
// Preserve every resource capacity, activity mapping, Profile and concurrency.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {hostname} from 'node:os';
assert.match(hostname(),/^servers-Mac-mini(?:\.|$)/);assert.equal(process.argv[2],'--activate');
const release=process.argv[3]==='--corrected'?'no-retry-20260923b':'no-retry-20260923';
const root='/Users/server/apps/crawler-v3',src=root+'/releases/'+release+'/source',base=src+'/apps/v3-workers/dist/ocr-cloud',out=root+'/manual-releases/'+release;
const read=p=>JSON.parse(fs.readFileSync(p)),write=(p,v)=>fs.writeFileSync(p,typeof v==='string'?v:JSON.stringify(v,null,2),{flag:'wx',mode:0o600});
const run=(bin,args)=>execFileSync(bin,args,{encoding:'utf8',timeout:180000,maxBuffer:2000000,stdio:['ignore','pipe','pipe']});
const before=read(root+'/live/deployment.json'),after=structuredClone(before),req=createRequire(src+'/apps/v3-workers/package.json'),{Pool}=req('pg'),db=new Pool({connectionString:before.database.connectionString,max:1,statement_timeout:10000});
const group=id=>['amazon-brand-workflow','amazon-product-workflow','amazon-catalog-workflow','amazon-channel-label-workflow'].includes(id)?'workflow':id.startsWith('amazon-channel-label-')?'label':id==='amazon-channel-product-input'?'plan':id.startsWith('amazon-')?'amazon':null;
const entry={workflow:'product-workflow-worker.js',label:'channel-label-worker.js',plan:'channel-plan-worker.js',amazon:'amazon-live-worker.js'};
const jobs=before.jobs.filter(j=>group(j.id));assert.equal(jobs.length,29);
assert.equal(read(root+'/releases/no-retry-20260923/focused-results.json').numFailedTests,0);
assert.equal(read(root+'/releases/no-retry-20260923/replay-health-proof.json').held,0);
if(release.endsWith('b'))assert.equal(read(root+'/releases/'+release+'/codex-results.json').numFailedTests,0);
try{
 assert.equal(Number((await db.query('SELECT count(*) n FROM resource_permit WHERE released_at IS NULL')).rows[0].n),0);
 const queue=JSON.parse(run(root+'/crawler-queue',['status']));assert.notEqual(queue.mode,'running');assert.equal(queue.counts.running??0,0);
 fs.mkdirSync(out,{mode:0o700});write(out+'/deployment-before.private.json',before);
 const builds={};for(const g of Object.keys(entry)){const h=createHash('sha256');for(const n of fs.readdirSync(base+'/'+g).filter(n=>n.endsWith('.js')||n==='product-workflows.cjs').sort()){const b=fs.readFileSync(base+'/'+g+'/'+n);h.update(String(b.length)+':').update(b);}builds[g]=h.digest('hex');}
 for(const j of after.jobs){const g=group(j.id);if(!g)continue;const old=read(j.env.V3_WORKER_CONFIG),runtime={...old,expectedBuildId:builds[g]};assert.equal(runtime.concurrency,old.concurrency);j.entry=base+'/'+g+'/'+entry[g];j.env.V3_WORKER_CONFIG=out+'/'+j.id+'.runtime.json';write(j.env.V3_WORKER_CONFIG,runtime);}
 assert.deepEqual(after.resources,before.resources);write(out+'/deployment-after.private.json',after);
 for(const name of ['health','queue'])run(root+'/crawler-maintenance',['stop',name]);
 for(const j of jobs){run(before.node,[root+'/manual-control.mjs','stop',j.id]);console.log(JSON.stringify({event:'STOPPED',id:j.id}));}
 const {serviceLabel}=await import(root+'/source/apps/v3-workers/dist/us-control/deployment-launchd.js');
 run('/bin/launchctl',['bootout','gui/'+process.getuid()+'/'+serviceLabel(before)]);
 fs.writeFileSync(root+'/live/deployment.json.next',JSON.stringify(after,null,2),{mode:0o600});fs.renameSync(root+'/live/deployment.json.next',root+'/live/deployment.json');
 for(const j of jobs){run(before.node,[root+'/manual-control.mjs','start',j.id]);const h=read(root+'/'+j.id+'.health.json');assert.equal(h.event,'WORKER_RUNNING');assert.equal(h.buildId,builds[group(j.id)]);write(out+'/'+j.id+'.ready.json',{id:j.id,pid:h.pid,buildId:h.buildId});console.log(JSON.stringify({event:'READY',id:j.id,pid:h.pid}));}
 // Change project-local plists only. No LaunchAgents, boot or login installation.
 for(const name of ['health','queue']){
  const p=root+'/manual-services/com.crawlv3.maintenance.promises.'+name+'.plist',old=fs.readFileSync(p,'utf8');
  assert.ok(old.includes('/releases/promises-20260922/source/'));write(out+'/'+name+'.before.plist',old);
  fs.writeFileSync(p,old.replaceAll('/releases/promises-20260922/source/','/releases/'+release+'/source/'),{mode:0o600});run('/usr/bin/plutil',['-lint',p]);
 }
 const cli=root+'/crawler-queue',old=fs.readFileSync(cli,'utf8');write(out+'/crawler-queue.before',old);fs.writeFileSync(cli,old.replace('/releases/promises-20260922/source/','/releases/'+release+'/source/'),{mode:0o700});
 write(out+'/activated.json',{at:new Date().toISOString(),builds,jobs:jobs.map(j=>j.id),limitsUnchanged:true,queueResumed:false});
 console.log(JSON.stringify({event:'CANDIDATE_ACTIVE',workers:jobs.length,limitsUnchanged:true,maintenanceStarted:false,queueResumed:false}));
}finally{await db.end();}
