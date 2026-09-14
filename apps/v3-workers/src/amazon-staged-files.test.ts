import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileCopies,ArtifactError,sha256} from '@crawl-automation/v3-artifacts';
import {FileEvidence,acquiredImageId,acquisitionKey} from '@crawl-automation/v3-acquisition';
import {AmazonStagedFiles,amazonStageKey} from './amazon-staged-files.js';
import {amazonFixture,AmazonMemory} from '../../../packages/v3-channels/src/amazon-live.fixture.js';
import {png} from '../../../packages/v3-acquisition/src/testing.fixture.js';
const signal=()=>AbortSignal.timeout(5000),roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){
 const f=amazonFixture(),job=await f.job(),capture=await f.live.capture(job,signal());await f.plans.run(capture.sourcePlan,signal());
 const description=await f.plans.inspect(capture.sourcePlan,signal());if(!description)throw Error('plan');
 const root=await mkdtemp(join(tmpdir(),'amazon-stage-test-'));roots.push(root);const copies=await FileCopies.open(root);
 const download=vi.fn(async(_c:any,input:any)=>({input,bytes:png,dimensions:{width:1,height:1},redirects:0,artifactDurable:false as const,resultRegistered:false as const,
  file:{schemaVersion:1 as const,artifactId:acquiredImageId(input.operationId),observationId:input.observationId,sourceId:input.sourceId,listingId:input.listingId,variantId:input.variantId,kind:'source-image' as const,mediaType:'image/png' as const,sha256:sha256(png),byteSize:png.length,objectKey:`v3/${input.observationId}/${input.operationId}/source`,producer:{operationId:input.operationId,module:input.module,implementationVersion:input.implementationVersion}}}));
 const rows=new Map<string,any>(),reviews={read:async(id:string)=>rows.get(id)??null,append:async(r:any)=>{rows.set(r.reviewId,r);}};
 const files=new FileEvidence({local:f.local,remote:f.remote,copies,reviews}),closed=vi.fn(async()=>{});
 const options={publication:f.publication,copies,files,storageId:'a'.repeat(64),describe:async()=>({plan:description,pageUrl:f.url}),closed,download};
 return{...f,root,capture,copies,download,files,closed,options,stage:new AmazonStagedFiles(options)};
}
it('stages every original locally; cold publisher with no download capability performs cloud-only completion',async()=>{
 const f=await fixture(),staged=await f.stage.stage(f.capture,signal());expect(staged.files).toHaveLength(2);
 for(const {record} of staged.files){expect(f.remote.data.has(record.file.objectKey)).toBe(false);expect(await readFile(join(f.root,record.file.sha256+'.blob'))).toEqual(png);expect(await f.files.inspect(record.input,signal())).toBeNull();}
 const {download,...cloud}=f.options;const cold=new AmazonStagedFiles({...cloud,copies:await FileCopies.open(f.root)});
 expect(await cold.stage(f.capture,signal())).toEqual(staged);
 const results=await Promise.all(staged.files.map(file=>cold.publish({staged,sourceId:file.sourceId},signal())));
 expect(results.map(r=>r.status)).toEqual(['durable','durable']);expect(f.download).toHaveBeenCalledTimes(2);expect(f.closed).toHaveBeenCalledTimes(2);
 for(const {record} of staged.files)expect(await f.files.inspect(record.input,signal())).toEqual(record);
});
it('cannot publish before exact browser closure and released permit verification',async()=>{
 const f=await fixture(),staged=await f.stage.stage(f.capture,signal());f.closed.mockRejectedValue(Error('AMAZON.STAGE_BROWSER_NOT_RELEASED'));
 await expect(f.stage.publish({staged,sourceId:staged.files[0]!.sourceId},signal())).rejects.toThrow('BROWSER_NOT_RELEASED');expect(f.remote.data.has(staged.files[0]!.record.file.objectKey)).toBe(false);
});
it.each(['corrupt','missing'])('cold restart detects %s local original and cannot redownload',async mode=>{
 const f=await fixture(),staged=await f.stage.stage(f.capture,signal()),path=join(f.root,staged.files[0]!.record.file.sha256+'.blob');
 if(mode==='corrupt')await writeFile(path,Buffer.alloc(png.length));else await rm(path);
 await expect(new AmazonStagedFiles(f.options).stage(f.capture,signal())).rejects.toThrow();
 expect(await f.stage.publish({staged,sourceId:staged.files[0]!.sourceId},signal())).toMatchObject({status:'review'});expect(f.download).toHaveBeenCalledTimes(2);
});
it('cancellation preserves accepted bytes and blocks a second origin pass even with a fresh local journal',async()=>{
 const f=await fixture(),controller=new AbortController(),download=f.download.getMockImplementation()!;
 f.download.mockImplementation(async(...args)=>{const result=await download(...args);controller.abort(Error('cancelled'));return result;});
 await expect(f.stage.stage(f.capture,controller.signal)).rejects.toThrow('cancelled');expect(await readFile(join(f.root,sha256(png)+'.blob'))).toEqual(png);expect(f.remote.data.has(amazonStageKey(f.capture))).toBe(false);
 const cold=new AmazonStagedFiles({...f.options,publication:new (f.publication.constructor as any)(new AmazonMemory(),f.remote)});
 await expect(cold.stage(f.capture,signal())).rejects.toThrow('STAGE_EXECUTION_UNKNOWN');expect(f.download).toHaveBeenCalledOnce();
});
it('lost upload and completion acknowledgements reconcile without a second PUT',async()=>{
 const f=await fixture(),staged=await f.stage.stage(f.capture,signal()),chosen=staged.files[0]!,create=f.remote.create.bind(f.remote),counts=new Map<string,number>();
 f.remote.create=async(key,bytes)=>{counts.set(key,(counts.get(key)??0)+1);const result=await create(key,bytes);if(key===chosen.record.file.objectKey)throw new ArtifactError('ARTIFACT.UPLOAD_UNKNOWN');if(key===acquisitionKey(chosen.record.input))throw Error('lost completion ack');return result;};
 expect(await f.stage.publish({staged,sourceId:chosen.sourceId},signal())).toMatchObject({status:'durable'});
 const {download,...cloud}=f.options;expect(await new AmazonStagedFiles(cloud).publish({staged,sourceId:chosen.sourceId},signal())).toMatchObject({status:'durable'});
 expect(counts.get(chosen.record.file.objectKey)).toBe(1);expect(counts.get(acquisitionKey(chosen.record.input))).toBe(1);expect(f.download).toHaveBeenCalledTimes(2);
});
it('unknown upload keeps a passive Review and local bytes; repeat cannot reissue upload',async()=>{
 const f=await fixture(),staged=await f.stage.stage(f.capture,signal()),chosen=staged.files[0]!,create=f.remote.create.bind(f.remote);let puts=0;
 f.remote.create=async(key,bytes)=>{if(key===chosen.record.file.objectKey){puts++;throw new ArtifactError('ARTIFACT.UPLOAD_UNKNOWN');}return create(key,bytes);};
 for(let n=0;n<2;n++)expect(await f.stage.publish({staged,sourceId:chosen.sourceId},signal())).toMatchObject({status:'review'});
 expect(puts).toBe(1);expect(await f.copies.read(chosen.record.file,signal())).toEqual(png);expect(f.download).toHaveBeenCalledTimes(2);
});
it('rejects a caller-supplied file from a different manifest before cloud mutation',async()=>{
 const f=await fixture(),staged=await f.stage.stage(f.capture,signal()),bad=structuredClone(staged);bad.files[0]!.record.file.sha256='b'.repeat(64);
 await expect(f.stage.publish({staged:bad,sourceId:bad.files[0]!.sourceId},signal())).rejects.toThrow('STAGE_IDENTITY_CONFLICT');expect(f.remote.data.has(staged.files[0]!.record.file.objectKey)).toBe(false);
});
