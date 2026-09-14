// Mini-only read-only proof of staged originals, publication ordering and timing.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {hostname} from 'node:os';
import {defaultPayloadConverter} from '@temporalio/common';
import temporalProto from '@temporalio/proto';
const [work]=process.argv.slice(2),main='/Users/barry/apps/crawlv3-batch-a.UiA4dx';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),sha=b=>createHash('sha256').update(b).digest('hex');
const {out}=await read(work+'/acceptance-10.json'),timing=await read(out+'/timing.json'),report=await read(out+'/report.json'),config=await read(work+'/amazon.private.json');
// Audit the file handoff separately from model quality. A terminal Review is
// preserved and reported, never counted as a successfully collected product.
assert.equal(report.products.length,10);assert.ok(report.products.every(p=>['collected','review'].includes(p.result.status)));
const productOutcomes={collected:report.products.filter(p=>p.result.status==='collected').length,review:report.products.filter(p=>p.result.status==='review').length};
const {createR2Objects}=await import(work+'/candidate/acceptance/purchase-conditions-inspect.js'),r2=createR2Objects(config.r2,config.r2Credentials);
const decode=v=>defaultPayloadConverter.fromPayload(v.payloads[0]);
const details=[],originals=[];
try{
 for(const w of timing.workflows.filter(w=>w.type==='AmazonCatalogProductWorkflow')){
  const {events}=temporalProto.temporal.api.history.v1.History.fromObject(await read(out+'/history-'+w.runId+'.json')),a=timing.activities.filter(a=>a.workflowId===w.id),stage=a.filter(a=>a.name==='stageAmazonProductFiles'),uploads=a.filter(a=>a.name==='publishAmazonStagedFile');
  assert.equal(stage.length,1);assert.ok(uploads.length>0);assert.ok(a.every(x=>!x.failed));assert.ok(!a.some(x=>x.name==='acquireAmazonFile'));
  const close=a.find(x=>x.name==='closeAmazonProductPage'),permit=timing.resourceSpans.find(s=>s.request.workflowId===w.id&&s.request.needs.some(n=>n.resourceId===config.browserResource));
  assert.ok(permit);assert.ok(stage[0].end<=close.start);assert.ok(close.end<=permit.end);assert.ok(uploads.every(u=>u.start>=permit.end));
  const scheduled=events.find(e=>e.activityTaskScheduledEventAttributes?.activityType?.name==='stageAmazonProductFiles');
  const complete=events.find(e=>e.activityTaskCompletedEventAttributes?.scheduledEventId?.toString()===scheduled.eventId.toString());
  const staged=decode(complete.activityTaskCompletedEventAttributes.result);
  assert.equal(staged.status,'staged');assert.equal(staged.files.length,uploads.length);
  const bytes=await r2.store.read('v3/amazon-staged/'+staged.capture.job.operationId+'/manifest.json',1024*1024,AbortSignal.timeout(30000));
  assert.ok(bytes);assert.deepEqual(JSON.parse(Buffer.from(bytes).toString()),staged);
  for(const f of staged.files){
   const r=f.record,completion=await r2.store.read('v3/acquisition/'+r.input.operationId+'/completion.json',65536,AbortSignal.timeout(30000));
   assert.ok(completion);assert.deepEqual(JSON.parse(Buffer.from(completion).toString()),r);
   originals.push(r.file);
  }
  details.push({workflowId:w.id,asin:staged.capture.job.discovery.entry.listingId,files:staged.files.length,browserSeconds:(permit.end-permit.start)/1000,stageSeconds:(stage[0].end-stage[0].start)/1000,allUploadsAfterCloseAndRelease:true});
 }
 assert.equal(details.length,10);
 // Verify every retained original at both locations. At most two remote reads at once.
 for(let offset=0;offset<originals.length;offset+=2)await Promise.all(originals.slice(offset,offset+2).map(async ref=>{
  const local=await fs.readFile(config.cacheRoot+'/'+ref.sha256+'.blob'),remote=await r2.store.read(ref.objectKey,ref.byteSize,AbortSignal.timeout(30000));
  for(const bytes of [local,remote]){assert.ok(bytes);assert.equal(bytes.length,ref.byteSize);assert.equal(sha(bytes),ref.sha256);}
 }));
 const phases={},owners=new Set(details.map(d=>d.workflowId));
 for(const role of ['capture','file'])for(const line of (await fs.readFile(main+'/amazon-'+role+'.log','utf8')).split('\n')){
  let v;try{v=JSON.parse(line);}catch{continue;}
  if(v.event!=='AMAZON_FILE_PHASE'||!owners.has(v.workflowId))continue;
  const p=phases[v.phase]??={count:0,seconds:0};p.count++;p.seconds+=v.milliseconds/1000;
 }
 const uploads=timing.activities.filter(a=>a.name==='publishAmazonStagedFile'),browser=timing.resourceSpans.filter(s=>owners.has(s.request.workflowId)&&s.request.needs.some(n=>n.resourceId===config.browserResource));
 const overlaps=uploads.flatMap(u=>browser.filter(b=>b.request.workflowId!==u.workflowId&&Math.max(b.start,u.start)<Math.min(b.end,u.end)).map(b=>({upload:u.workflowId,browser:b.request.workflowId,seconds:(Math.min(b.end,u.end)-Math.max(b.start,u.start))/1000})));
 let active=0,peak=0;for(const [,change]of uploads.flatMap(u=>[[u.start,1],[u.end,-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1])){active+=change;peak=Math.max(peak,active);}assert.ok(peak<=2);assert.ok(overlaps.length>0);
 assert.equal(phases.origin_download.count,originals.length);assert.equal(phases.local_preservation.count,originals.length);assert.equal(phases.cloud_upload_and_readback.count,originals.length);
 const result={fileHandoffVerified:true,products:details.length,productOutcomes,passiveReviewsPreserved:report.reviews.length,originalsVerifiedLocallyAndRemotely:originals.length,uploadActivityPeak:peak,cloudUploadOverlapsNextBrowser:overlaps.length,phases,details};
 await fs.writeFile(out+'/detached-proof.json',JSON.stringify(result,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify({...result,details:undefined}));
}finally{r2.close();}
