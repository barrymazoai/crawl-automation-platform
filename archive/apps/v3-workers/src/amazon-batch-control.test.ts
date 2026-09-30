import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {sha256} from '@crawl-automation/v3-artifacts';
import {AmazonBatchController} from './amazon-batch-control.js';

async function fixture(count=2000){
 const root=await fs.mkdtemp(join(tmpdir(),'amazon-batch-test-')),campaignId='batch-test';
 const products=Array.from({length:count},(_,n)=>({asin:'B'+String(n).padStart(9,'0')}));
 const scope={brandId:randomUUID(),sourceId:randomUUID(),channel:'amazon',region:'US',rootUrl:'https://www.amazon.com/',scopeVersion:'source-revision-2'};
 const batches=Array.from({length:Math.ceil(count/4)},(_,n)=>({codec:'amazon-link-batch/1',requestId:randomUUID(),scope,candidateManifestSha256:'a'.repeat(64),entries:products.slice(n*4,n*4+4).map(p=>({candidateId:'b'.repeat(64),historyListingId:'c'.repeat(64),entry:{listingId:p.asin,url:'https://www.amazon.com/dp/'+p.asin,kind:'product',variantId:null}}))}));
 const bytes=Buffer.from(JSON.stringify({codec:'amazon-history-campaign/1',campaignId,region:'US',postalCode:'10001',productCount:count,products,batches}));
 await fs.writeFile(root+'/plan.json',bytes);await fs.writeFile(root+'/price-baseline.json','[]');
 const config={campaignId,manifestPath:root+'/plan.json',manifestSha256:sha256(bytes),dataRoot:root,adminFile:root+'/admin.json',recoveryHelper:root+'/recovery.js',controlQueue:'queue'};
 let healthy=true,held=0,state='COMPLETED';
 const db={query:async(sql:string)=>({rows:sql.includes('current_database')?[{name:'crawler_v3_test'}]:sql.includes('resource_capacity')?[1,2,3].map(()=>({healthy,fresh:true})):sql.includes('catalog_discovery')?batches[0]!.entries.map(e=>({record:{entry:e.entry,workflowId:e.entry.listingId}})):[{n:held}]})};
 const controller=await AmazonBatchController.open(config,db as any,{workflow:{getHandle:()=>({describe:async()=>({status:{name:state}})})}} as any),batch=batches[0]!,call={campaignId,manifestSha256:config.manifestSha256,requestId:batch.requestId};
 const submission={requestId:batch.requestId,workflowId:'v3-collection-'+batch.requestId,snapshot:{...scope,url:scope.rootUrl,sourceRevision:2}};
 return{root,controller,config,batch,call,submission,setHealthy:(v:boolean)=>healthy=v,setHeld:(v:number)=>held=v,setState:(v:string)=>state=v};
}
it('lost intake reply reconciles the same request; unhealthy dependencies and foreign revisions cannot submit',async()=>{
 const f=await fixture();let accepted=false,posts=0;
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init:any)=>{
  if(init.method==='POST'){posts++;expect(init.headers['Idempotency-Key']).toBe(f.batch.requestId);accepted=true;throw Error('reply lost after durable intake');}
  return accepted?Response.json(f.submission):new Response('',{status:404});
 }));
 try{
  f.setHealthy(false);expect(await f.controller.submitAmazonHistoryChunk(f.call,AbortSignal.timeout(1000))).toMatchObject({accepted:false});expect(posts).toBe(0);
  f.setHealthy(true);await expect(f.controller.submitAmazonHistoryChunk(f.call,AbortSignal.timeout(1000))).rejects.toThrow('reply lost');
  expect(await f.controller.submitAmazonHistoryChunk(f.call,AbortSignal.timeout(1000))).toMatchObject({accepted:true});expect(posts).toBe(1);
  f.submission.snapshot.sourceRevision=3;await expect(f.controller.submitAmazonHistoryChunk(f.call,AbortSignal.timeout(1000))).rejects.toThrow('SUBMISSION_CONFLICT');expect(posts).toBe(1);
  await expect(f.controller.submitAmazonHistoryChunk({...f.call,requestId:randomUUID()},AbortSignal.timeout(1000))).rejects.toThrow('BATCH_REQUEST');
 }finally{vi.unstubAllGlobals();await fs.rm(f.root,{recursive:true,force:true});}
});
it('a ten-product pilot has a finite plan and rejects an eleventh product before intake',async()=>{
 const f=await fixture(10),fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 try{
  expect(await f.controller.loadAmazonHistoryBatch(f.call)).toMatchObject({totalProducts:10,requestIds:expect.any(Array)});
  expect((await f.controller.loadAmazonHistoryBatch(f.call)).requestIds).toHaveLength(3);
  await expect(f.controller.submitAmazonHistoryChunk({...f.call,requestId:randomUUID()},AbortSignal.timeout(1000))).rejects.toThrow('BATCH_REQUEST');expect(fetch).not.toHaveBeenCalled();
  const raw=JSON.parse(await fs.readFile(f.config.manifestPath,'utf8'));raw.products.push({asin:'B000000010'});
  const altered=Buffer.from(JSON.stringify(raw));await fs.writeFile(f.config.manifestPath,altered);
  await expect(AmazonBatchController.open({...f.config,manifestSha256:sha256(altered)},{} as any,{} as any)).rejects.toThrow('BATCH_SELECTION');
 }finally{vi.unstubAllGlobals();await fs.rm(f.root,{recursive:true,force:true});}
});
it('closed delivery requires exact discoveries and released permits; changed manifest fails before use',async()=>{
 const f=await fixture();vi.stubGlobal('fetch',vi.fn(async()=>Response.json({item:{state:'CLOSED',observedStatus:'COMPLETED'}})));
 try{
  f.setHeld(1);await expect(f.controller.inspectAmazonHistoryChunk(f.call,AbortSignal.timeout(1000))).rejects.toThrow('PERMIT_HELD');
  f.setHeld(0);expect(await f.controller.inspectAmazonHistoryChunk(f.call,AbortSignal.timeout(1000))).toMatchObject({settled:true});
  await fs.appendFile(f.config.manifestPath,' ');await expect(AmazonBatchController.open(f.config,{} as any,{} as any)).rejects.toThrow('MANIFEST_CHANGED');
 }finally{vi.unstubAllGlobals();await fs.rm(f.root,{recursive:true,force:true});}
});
it('reports a stopped child model permit as recovery-required instead of waiting forever',async()=>{
 const f=await fixture(1);f.setHeld(1);f.setState('FAILED');
 try{await expect(f.controller.recoverAmazonHistoryChunk(f.call,AbortSignal.timeout(1000))).rejects.toThrow('AMAZON.BATCH_LABEL_RECOVERY_REQUIRED');}
 finally{await fs.rm(f.root,{recursive:true,force:true});}
});
