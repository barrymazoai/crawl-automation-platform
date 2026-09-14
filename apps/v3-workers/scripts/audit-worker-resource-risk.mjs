import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import pg from 'pg';
// Classify live role routes, not unused functions bundled beside an Activity.
const gatedRoles=new Set(['gnc-core-stream-workflow','catalog-workflow','swanson-product-workflow','channel-label-workflow','dtc-product-workflow','amazon-product-workflow']);
const stopRoles=new Set(['channel-label-text','channel-label-vision','channel-label-resources']);
const outputName=process.argv[2]??'worker-audit.json';if(!/^[a-z0-9-]+\.json$/.test(outputName))throw Error('Invalid audit filename');
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',dir='/Users/barry/apps/crawlv3-history-20260913/worker-resource-audit-20260914',read=async p=>JSON.parse(await fs.readFile(p,'utf8')),exec=promisify(execFile),cache=new Map();
await fs.mkdir(dir,{recursive:true,mode:0o700});
async function code(p){if(!cache.has(p))cache.set(p,await fs.readFile(p,'utf8'));return cache.get(p);}
const report={at:new Date().toISOString(),deployments:[],held:[]};
for(const file of [main+'/live/deployment.json',main+'/dtc-innerbody-v2-20260911/private/deployment.json',main+'/amazon-pilot-10-20260913/deployment.json']){
 const m=await read(file),s=await read(m.root+'/status.json'),jobs=[];
 for(const j of m.jobs){const r=j.env.V3_WORKER_CONFIG?await read(j.env.V3_WORKER_CONFIG):{},h=await read(m.root+'/'+j.id+'.health.json').catch(()=>null),current=s.jobs.find(x=>x.id===j.id),entry=await code(j.entry),wf=path.join(path.dirname(j.entry),j.entry.includes('amazon-batch-worker')?'amazon-batch-workflows.cjs':'product-workflows.cjs');
  const bundle=await code(wf).catch(()=>''),actual=current?.pid?(await exec('/bin/ps',['-p',String(current.pid),'-o','command=']).catch(()=>({stdout:''}))).stdout.trim():'';
  jobs.push({id:j.id,role:r.role,entry:j.entry,pid:current?.pid??null,ready:current?.ready??false,processMatches:actual.includes(j.entry),runtimeBuild:r.expectedBuildId,healthBuild:h?.buildId,buildMatches:r.expectedBuildId?h?.buildId===r.expectedBuildId:null,entrySha256:createHash('sha256').update(entry).digest('hex'),
   stopsPublisher:stopRoles.has(r.role)?entry.includes('STOP_EVIDENCE_IO_FAILED'):null,reviewVerifier:entry.includes('verifyResourceReviewStopped'),boundedGate:gatedRoles.has(r.role)?bundle.includes('resource-recovery-bounds-v1'):null,capacityWait:bundle?bundle.includes('resource-capacity-wait-v1'):null,
   modelRecovery:entry.includes('AMAZON.BATCH_LABEL_RECOVERY_REQUIRED'),taskQueue:h?.taskQueue});
 }
 report.deployments.push({manifest:file,root:m.root,monitorPid:s.pid,at:s.at,mode:s.mode,ready:jobs.filter(j=>j.ready).length,total:jobs.length,jobs});
 const db=new pg.Pool({connectionString:m.database.connectionString,max:1,connectionTimeoutMillis:5000,statement_timeout:5000});
 try{const rows=(await db.query("select permit_id,request->>'workflowId' workflow_id,request->>'runId' run_id,request->'needs' needs,granted_at from resource_permit where released_at is null order by granted_at")).rows;report.held.push({root:m.root,rows});}finally{await db.end();}
}
await fs.writeFile(dir+'/'+outputName,JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({at:report.at,deployments:report.deployments.map(d=>({root:d.root,ready:d.ready,total:d.total,buildMismatch:d.jobs.filter(j=>j.buildMatches===false||!j.processMatches).map(j=>j.id),oldStopPublishers:d.jobs.filter(j=>j.stopsPublisher===false).map(j=>j.id),oldWorkflowBundles:d.jobs.filter(j=>j.boundedGate===false&&j.capacityWait).map(j=>j.id)})),held:report.held}));
