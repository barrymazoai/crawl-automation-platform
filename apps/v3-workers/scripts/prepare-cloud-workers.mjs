// Mini: generate the private + runtime configs for the two Windows cloud-worker sets from the live Amazon
// label configs, and stage them with the release and the mTLS certificate files for hand-off.
//   node prepare-cloud-workers.mjs <release-dir-with-BUILD_ID> <out-dir>
// US machine:    ocr (concurrency 6, endpoint 127.0.0.1:8081) + text 2 + vision 2   -> model 4
// Local machine: text 3 + vision 3                                                    -> model 6
// Nothing on Mini changes; the ledger capacity (model 4+4+6=14) is applied separately by apply-mini-capacities.mjs.
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {hostname} from 'node:os';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const [release,out]=process.argv.slice(2);assert.ok(release&&out,'usage: prepare-cloud-workers.mjs <release> <out>');
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',read=async p=>JSON.parse(await fs.readFile(p,'utf8')),keep=(p,v)=>fs.writeFile(p,typeof v==='string'?v:JSON.stringify(v,null,2),{flag:'wx',mode:0o600});
const buildId=(await fs.readFile(path.join(release,'BUILD_ID'),'utf8')).trim();assert.match(buildId,/^[a-f0-9]{64}$/);
const m=await read(main+'/live/deployment.json'),job=id=>m.jobs.find(j=>j.id===id);
const base={ocr:job('amazon-channel-label-ocr'),text:job('amazon-channel-label-text'),vision:job('amazon-channel-label-vision')};
for(const [k,j] of Object.entries(base))assert.ok(j,k);
const sets={us:{ocr:6,text:2,vision:2},local:{text:3,vision:3}};
await fs.mkdir(out,{recursive:true,mode:0o700});
for(const [node,roles] of Object.entries(sets)){
 const dir=path.join(out,node);await fs.mkdir(path.join(dir,'private'),{recursive:true,mode:0o700});
 const certs=new Set();
 for(const [role,concurrency] of Object.entries(roles)){
  const j=base[role],rt=await read(j.env.V3_WORKER_CONFIG),priv=await read(j.env.V3_CHANNEL_LABEL_CONFIG);
  for(const f of [rt.transport.caFile,rt.transport.certFile,rt.transport.keyFile])certs.add(f);
  // Windows paths are placeholders the deployer fills in; everything else is bound to the same queue scope as Mini.
  const runtime={...rt,hostId:`${node}-amazon-${role}`,concurrency,expectedBuildId:buildId,
   transport:{...rt.transport,caFile:'D:\\\\crawlv3-cloud\\\\private\\\\ca.pem',certFile:'D:\\\\crawlv3-cloud\\\\private\\\\client.pem',keyFile:'D:\\\\crawlv3-cloud\\\\private\\\\client.key'}};
  const {database:_db,resourceDatabase:_rdb,...rest}=priv;
  const cloud={...rest,root:`D:\\\\crawlv3-cloud\\\\work\\\\${role}`,
   ...(role==='ocr'?{ocrProvider:{...priv.ocrProvider,endpoint:'http://127.0.0.1:8081/ocr',trustedHttpOrigin:'http://127.0.0.1:8081'}}:{}),
   ...(priv.codex?{codex:{...priv.codex,executable:'D:\\\\crawlv3-cloud\\\\codex\\\\codex.exe',codexHome:'D:\\\\crawlv3-cloud\\\\codex-home',workRoot:`D:\\\\crawlv3-cloud\\\\work\\\\${role}\\\\model-work`}}:{})};
  await keep(path.join(dir,'private',`channel-label-${role}.runtime.json`),runtime);
  await keep(path.join(dir,'private',`channel-label-${role}.private.json`),cloud);
 }
 for(const f of certs)await fs.copyFile(f,path.join(dir,'private',path.basename(f)),fs.constants.COPYFILE_EXCL);
 await fs.cp(release,path.join(dir,'release'),{recursive:true});
 await keep(path.join(dir,'HANDOFF.md'),[`# ${node} cloud workers`,'',`buildId: ${buildId}`,'',
  'Roles and concurrency: '+JSON.stringify(roles),'',
  'Fill in on the Windows machine before starting: transport.caFile/certFile/keyFile (files are in private/), codex.executable, codex.codexHome, codex.workRoot, root.',
  'Start each role with V3_WORKER_ENABLED=true V3_WORKER_CONFIG=<runtime> V3_CHANNEL_LABEL_ENABLED=true V3_CHANNEL_LABEL_CONFIG=<private> node release/channel-label-worker.js',''].join('\n'));
 console.log(JSON.stringify({event:'CLOUD_WORKER_SET_PREPARED',node,roles,dir}));
}
