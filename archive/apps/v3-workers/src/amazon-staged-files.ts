import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { AmazonProductCaptureSchema, AmazonStagedFilesSchema, AcquiredFileRecordSchema, observationIdentity,
 type AmazonStagedFiles as StagedFiles, type FileAcquireInput, type ChannelProductPlan, type AcquiredFileRecord, type FileAcquireOutcome } from '@crawl-automation/v3-contracts';
import { ArtifactResolver, RetainedPublication, verifyBytes, type LocalCopies } from '@crawl-automation/v3-artifacts';
import { FileEvidence, acquisitionKey, acquiredImageId, type AcquiredFile } from '@crawl-automation/v3-acquisition';

type Capture=ReturnType<typeof AmazonProductCaptureSchema.parse>;
type Description={plan:ChannelProductPlan;pageUrl:string};
const bytes=(value:unknown)=>Buffer.from(JSON.stringify(value));
const limit=1024*1024;
export const amazonStageKey=(c:Capture)=>`v3/amazon-staged/${c.job.operationId}/manifest.json`;
/** Browser download and local preservation, then a separate cloud-only publisher.
 * A shared claim prevents a second origin pass even if a host loses its journal. */
export class AmazonStagedFiles {
 constructor(private readonly o:{storageId:string;publication:RetainedPublication;copies:LocalCopies;files:FileEvidence;
  describe(c:Capture,s:AbortSignal):Promise<Description>;closed(c:Capture,s:AbortSignal):Promise<unknown>;
  download?:(c:Capture,input:FileAcquireInput,url:string,pageUrl:string,s:AbortSignal)=>Promise<AcquiredFile>;
  timing?:(phase:string,milliseconds:number)=>void}){}
 private async timed<T>(phase:string,fn:()=>Promise<T>):Promise<T>{const start=performance.now();try{return await fn();}finally{this.o.timing?.(phase,performance.now()-start);}}
 private validate(raw:unknown,capture:Capture,description:Description){
  const staged=AmazonStagedFilesSchema.parse(raw),sources=description.plan.manifest.sources.filter(s=>s.kind==='file-image');
  if(!equal(staged.capture,capture)||staged.storageId!==this.o.storageId||staged.files.length!==sources.length)throw Error('AMAZON.STAGE_IDENTITY_CONFLICT');
  for(const [index,source] of sources.entries()){
   const file=staged.files[index]!;
   if(file.sourceId!==source.id||!equal(file.record.input,source.plan.acquire)||file.record.file.artifactId!==acquiredImageId(source.plan.acquire.operationId)||file.record.file.objectKey!==`v3/${source.plan.acquire.observationId}/${source.plan.acquire.operationId}/source`)
    throw Error('AMAZON.STAGE_IDENTITY_CONFLICT');
  }
  return staged;
 }
 private async local(record:AcquiredFileRecord,s:AbortSignal){
  const content=await this.o.copies.read(record.file,s);
  if(!content)throw Error('ACQUIRE.STAGED_BYTES_MISSING');
  verifyBytes(record.file,content,4*1024*1024);return content;
 }
 private async stored(c:Capture,d:Description,s:AbortSignal){
  const raw=await this.o.publication.remote.read(amazonStageKey(c),limit,s);
  if(!raw)return null;
  return this.validate(JSON.parse(Buffer.from(raw).toString()),c,d);
 }
 async stage(raw:unknown,s:AbortSignal):Promise<StagedFiles>{
  const c=AmazonProductCaptureSchema.parse(raw),d=await this.o.describe(c,s),old=await this.stored(c,d,s);
  if(old){for(const f of old.files)await this.local(f.record,s);return old;}
  if(!this.o.download)throw Error('AMAZON.STAGE_CAPTURE_UNAVAILABLE');
  const sources=d.plan.manifest.sources.filter(x=>x.kind==='file-image');if(!sources.length)throw Error('AMAZON.STAGE_FILES_REQUIRED');
  const key=`v3/amazon-staged/${c.job.operationId}/intent.json`,claim={capture:c,storageId:this.o.storageId,nonce:randomUUID()};
  const created=await this.o.publication.remote.create(key,bytes(claim),'application/json',s);
  const confirmed=await this.o.publication.remote.read(key,limit,s);
  if(created!=='created'||!confirmed||!equal(JSON.parse(Buffer.from(confirmed).toString()),claim))throw Error('AMAZON.STAGE_EXECUTION_UNKNOWN');
  const files:StagedFiles['files']=[];
  for(const source of sources){
   const url=d.plan.files.find(f=>f.resourceId===source.plan.acquire.resourceId)?.url;if(!url)throw Error('AMAZON.STAGE_IDENTITY_CONFLICT');
   const acquired=await this.timed('origin_download',()=>this.o.download!(c,source.plan.acquire,url,d.pageUrl,s));
   const record=AcquiredFileRecordSchema.parse({schemaVersion:1,codec:'acquired-file/1',input:acquired.input,file:acquired.file,dimensions:acquired.dimensions,redirects:acquired.redirects});
   if(!equal(record.input,source.plan.acquire)||record.file.kind!=='source-image')throw Error('AMAZON.STAGE_IDENTITY_CONFLICT');
   // Preserve accepted bytes and their provenance even after a late cancellation.
   await this.timed('local_preservation',async()=>{
    const keep=AbortSignal.timeout(10000);await this.o.copies.retain(record.file,acquired.bytes,keep);await this.local(record,keep);
    await this.o.publication.retain(`v3/amazon-staged/${c.job.operationId}/${source.plan.acquire.operationId}.json`,bytes({capture:c,sourceId:source.id,record}),'application/json',keep);
   });
   files.push({sourceId:source.id,record});s.throwIfAborted();
  }
  const staged=this.validate({codec:'amazon-staged-files/1',status:'staged',capture:c,storageId:this.o.storageId,files},c,d);
  await this.timed('stage_manifest_publication',()=>this.o.publication.publish(amazonStageKey(c),bytes(staged),'application/json',s));
  return staged;
 }
 async publish(raw:{staged:unknown;sourceId:string},s:AbortSignal):Promise<FileAcquireOutcome>{
  const supplied=AmazonStagedFilesSchema.parse(raw.staged),c=supplied.capture;
  // This callback reads page-close evidence and the released permit, never CDP.
  await this.o.closed(c,s);
  const d=await this.o.describe(c,s),stored=await this.stored(c,d,s);
  if(!stored||!equal(stored,supplied))throw Error('AMAZON.STAGE_IDENTITY_CONFLICT');
  const chosen=stored.files.find(f=>f.sourceId===raw.sourceId);if(!chosen)throw Error('AMAZON.STAGE_IDENTITY_CONFLICT');
  const record=chosen.record,input=record.input,receipt=(r:AcquiredFileRecord):FileAcquireOutcome=>({status:'durable',operationId:input.operationId,file:r.file,evidenceKey:acquisitionKey(input)});
  try{
   const prior=await this.o.files.inspect(input,s);if(prior){if(!equal(prior,record))throw Error('AMAZON.STAGE_IDENTITY_CONFLICT');return receipt(prior);}
   const content=await this.local(record,s),key=`acquisition-intents/${input.operationId}.json`,claim={input,nonce:randomUUID()};
   const created=await this.o.publication.remote.create(key,bytes(claim),'application/json',s),confirmed=await this.o.publication.remote.read(key,65536,s);
   if(created!=='created'||!confirmed||!equal(JSON.parse(Buffer.from(confirmed).toString()),claim))throw Error('ACQUIRE.EXECUTION_UNKNOWN');
   await this.timed('cloud_upload_and_readback',()=>new ArtifactResolver(this.o.copies,this.o.publication.remote).publish(record.file,observationIdentity(input),content,s));
   await this.timed('file_completion_publication',()=>this.o.files.publish(acquisitionKey(input),record,s));
   const complete=await this.o.files.inspect(input,s);if(!complete||!equal(complete,record))throw Error('ACQUIRE.NOT_DURABLE');
   return receipt(complete);
  }catch(error){
   try{const complete=await this.o.files.inspect(input,AbortSignal.timeout(10000));if(complete&&equal(complete,record))return receipt(complete);}catch{/* Preserve unknown; no second upload or origin download. */}
   return this.o.files.review(input,'file.acquire',error,record);
  }
 }
}
