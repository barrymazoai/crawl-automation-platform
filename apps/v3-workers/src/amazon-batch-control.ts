import fs from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {isDeepStrictEqual as equal,promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {z} from 'zod';
import type pg from 'pg';
import type {Client} from '@temporalio/client';
import {sha256} from '@crawl-automation/v3-artifacts';
import {AmazonLinkBatchesSchema,type AmazonLinkBatch} from './amazon-link-batches.js';
import type {BatchCall,BatchReport} from './amazon-batch-contract.js';
const path=z.string().refine(isAbsolute);
export const AmazonBatchConfigSchema=z.strictObject({campaignId:z.string(),manifestPath:path,manifestSha256:z.string().regex(/^[a-f0-9]{64}$/),dataRoot:path,adminFile:path,recoveryHelper:path,controlQueue:z.string()});
export type AmazonBatchConfig=z.infer<typeof AmazonBatchConfigSchema>;
export class AmazonBatchController{
 private constructor(readonly config:AmazonBatchConfig,private db:pg.Pool,private client:Client,private batches:AmazonLinkBatch[],private products:Map<string,any>,private baseline:any[]){}
 static async open(config:AmazonBatchConfig,db:pg.Pool,client:Client){
  const bytes=await fs.readFile(config.manifestPath);if(sha256(bytes)!==config.manifestSha256)throw Error('AMAZON.BATCH_MANIFEST_CHANGED');
  const raw=JSON.parse(bytes.toString());if(raw.codec!=='amazon-history-campaign/1'||raw.campaignId!==config.campaignId||raw.region!=='US'||raw.postalCode!=='10001'||raw.productCount!==2000)throw Error('AMAZON.BATCH_POLICY');
  const batches=AmazonLinkBatchesSchema.parse(raw.batches),products=new Map<string,any>(raw.products.map((p:any)=>[p.asin,p]));
  if(products.size!==2000||new Set(batches.flatMap(b=>b.entries.map(e=>e.entry.listingId))).size!==2000||batches.some(b=>b.scope.region!=='US'||b.entries.some(e=>!products.has(e.entry.listingId))))throw Error('AMAZON.BATCH_SELECTION');
  if((await db.query('select current_database() name')).rows[0].name!=='crawler_v3_test')throw Error('AMAZON.BATCH_DATABASE');
  const baseline=JSON.parse(await fs.readFile(config.dataRoot+'/price-baseline.json','utf8'));
  return new AmazonBatchController(config,db,client,batches,products,baseline);
 }
 private validate(raw:BatchCall,chunk=false){
  if(raw.campaignId!==this.config.campaignId||raw.manifestSha256!==this.config.manifestSha256)throw Error('AMAZON.BATCH_IDENTITY');
  const batch=this.batches.find(b=>b.requestId===raw.requestId);if(chunk&&!batch)throw Error('AMAZON.BATCH_REQUEST');return batch!;
 }
 private async api(path:string,signal:AbortSignal,method='GET',body?:unknown,key?:string){
  const response=await fetch('http://127.0.0.1:4188/api/v3'+path,{method,signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),headers:{'X-V3-Client':'local-workspace',...(method!=='GET'?{Origin:'http://127.0.0.1:4188','Content-Type':'application/json','Idempotency-Key':key!}:{})},...(body?{body:JSON.stringify(body)}:{})});
  if(response.status===404&&method==='GET')return null;
  if(!response.ok)throw Error('AMAZON.BATCH_API_'+response.status);return response.json();
 }
 private async event(event:unknown){await fs.appendFile(this.config.dataRoot+'/temporal-events.jsonl',JSON.stringify({at:new Date().toISOString(),...event as object})+'\n',{mode:0o600});}
 private async save(name:string,data:unknown){const target=this.config.dataRoot+'/'+name,tmp=target+'.'+process.pid+'.next';await fs.writeFile(tmp,JSON.stringify(data,null,2),{mode:0o600});await fs.rename(tmp,target);}
 async loadAmazonHistoryBatch(raw:BatchCall){this.validate(raw);return{requestIds:this.batches.map(b=>b.requestId),totalProducts:this.products.size};}
 async submitAmazonHistoryChunk(raw:BatchCall,signal:AbortSignal){
  const batch=this.validate(raw,true),id=batch.requestId;let submission=await this.api('/submissions/'+id,signal);
  if(!submission){
   const dependencies=(await this.db.query("select resource_id,healthy,health_until>now() fresh from resource_capacity where resource_id=ANY($1)",[['mini-ego-space-1','mini-model-account','windows-ocr']])).rows;
   if(dependencies.length!==3||dependencies.some(d=>!d.healthy||!d.fresh))return{accepted:false,workflowId:null};
   await this.event({event:'SUBMIT_INTENT',requestId:id,asins:batch.entries.map(e=>e.entry.listingId)});
   submission=await this.api('/brands/'+batch.scope.brandId+'/sources/'+batch.scope.sourceId+'/submissions',signal,'POST',{sourceRevision:Number(batch.scope.scopeVersion.replace('source-revision-',''))},id);
  }
  if(submission.requestId!==id||submission.workflowId!=='v3-collection-'+id||submission.snapshot.channel!=='amazon'||submission.snapshot.url!==batch.scope.rootUrl||submission.snapshot.region!=='US'||submission.snapshot.brandId!==batch.scope.brandId||submission.snapshot.sourceId!==batch.scope.sourceId||submission.snapshot.sourceRevision!==Number(batch.scope.scopeVersion.replace('source-revision-','')))throw Error('AMAZON.BATCH_SUBMISSION_CONFLICT');
  await this.event({event:'SUBMISSION_RECONCILED',requestId:id,workflowId:submission.workflowId});return{accepted:true,workflowId:submission.workflowId};
 }
 async inspectAmazonHistoryChunk(raw:BatchCall,signal:AbortSignal){
  const batch=this.validate(raw,true),receipt=await this.api('/submissions/'+batch.requestId+'/delivery',signal),delivery=receipt?.item;
  if(!delivery||delivery.state!=='CLOSED')return{settled:false,workflowId:'v3-collection-'+batch.requestId,state:delivery?.observedStatus??'PENDING'};
  if(delivery.observedStatus!=='COMPLETED')throw Error('AMAZON.BATCH_ROOT_NOT_SETTLED');
  const discoveries=(await this.db.query('select record from catalog_discovery where catalog_id=$1',[batch.requestId])).rows.map(r=>r.record);
  if(!equal(discoveries.map(d=>d.entry.listingId).sort(),batch.entries.map(e=>e.entry.listingId).sort()))throw Error('AMAZON.BATCH_DISCOVERY_CONFLICT');
  const ids=discoveries.flatMap(d=>[d.workflowId,d.workflowId+'-label']);
  if((await this.db.query("select count(*)::int n from resource_permit where released_at is null and request->>'workflowId'=ANY($1)",[ids])).rows[0].n)throw Error('AMAZON.BATCH_PERMIT_HELD');
  return{settled:true,workflowId:'v3-collection-'+batch.requestId,state:'COMPLETED'};
 }
 async recoverAmazonHistoryChunk(raw:BatchCall,signal:AbortSignal){
  const batch=this.validate(raw,true);
  const permits=(await this.db.query("select p.permit_id,p.request from resource_permit p join catalog_discovery d on d.record->>'workflowId'=p.request->>'workflowId' where p.released_at is null and d.catalog_id=$1",[batch.requestId])).rows;
  if(!permits.length)return{status:'not-needed'};
  const browser=permits.filter(p=>equal(p.request.needs,[{resourceId:'mini-ego-space-1',units:1}]));if(!browser.length)return{status:'waiting'};if(browser.length!==1)throw Error('AMAZON.BATCH_PERMIT_AMBIGUOUS');
  const p=browser[0],state=await this.client.workflow.getHandle(p.request.workflowId,p.request.runId).describe();
  if(!['COMPLETED','FAILED'].includes(state.status.name))return{status:'waiting'};
  const childPermits=(await this.db.query("select count(*)::int n from resource_permit where released_at is null and request->>'workflowId'=$1",[p.request.workflowId+'-label'])).rows[0].n;
  if(childPermits)return{status:'waiting'};
  signal.throwIfAborted();
  const out=await promisify(execFile)(process.execPath,[this.config.recoveryHelper,'--release',p.permit_id],{timeout:120000,maxBuffer:1024*1024,signal});
  const proof=JSON.parse(out.stdout.trim());if(proof.status!=='released'||proof.requestId!==batch.requestId||proof.request.permitId!==p.permit_id)throw Error('AMAZON.BATCH_RECOVERY_UNVERIFIED');
  await this.event({event:'CLOSED_PAGE_PERMIT_RECOVERED',requestId:batch.requestId,permitId:p.permit_id,proofKey:proof.proofKey});return{status:'released'};
 }
 async reportAmazonHistoryBatch(raw:BatchCall):Promise<BatchReport>{
  this.validate(raw);const ids=this.batches.map(b=>b.requestId);
  const captures=(await this.db.query("select record from product_history_source where dataset='v3:amazon' and record->>'codec'='v3-capture-history/1' and record->'owner'->>'requestId'=ANY($1) order by record->>'capturedAt'",[ids])).rows.map(r=>r.record);
  const saved=(await this.db.query("select record->'observation'->>'listingId' asin from collected_product where record->'observation'->>'requestId'=ANY($1)",[ids])).rows;
  const submitted=new Set((await this.db.query('select request_id from collection_submission where request_id::text=ANY($1)',[ids])).rows.map(s=>s.request_id));
  const reviews=(await this.db.query("select count(*)::int n from review_record where record->'observation'->>'requestId'=ANY($1)",[ids])).rows[0].n;
  const prices=captures.map(c=>{const asin=c.listing.externalId,p=this.products.get(asin),old=this.baseline.filter(x=>x.asin===asin&&x.observed_at&&x.record.price!==null&&x.record.price!==undefined&&String(x.record.price).trim()!==''&&Number.isFinite(Number(x.record.price))&&Date.parse(x.observed_at)<Date.parse(c.capturedAt)).sort((a,b)=>Date.parse(b.observed_at)-Date.parse(a.observed_at))[0];
   const oldPrice=old?.record.price??null,newPrice=c.metrics.price,oldCurrency=old?.record.currency??null,newCurrency=c.metrics.currency,comparable=oldPrice!==null&&newPrice!==null&&oldCurrency!==null&&oldCurrency===newCurrency;
   return{asin,title:c.capture?.projection?.title??p?.title,url:p?.url,oldAt:old?.observed_at??null,oldPrice,oldCurrency,newAt:c.capturedAt,newPrice,newCurrency,delivery:'New York 10001',difference:comparable?Number((Number(newPrice)-Number(oldPrice)).toFixed(4)):null,changePercent:comparable&&Number(oldPrice)>0?Number(((Number(newPrice)/Number(oldPrice)-1)*100).toFixed(2)):null,comparisonNote:'页面报价观测；旧购买条件未完整记录，不代表同条件成交价格变化',newContext:c.metrics.extras,observationId:c.observationId};
  });
  const accepted=this.batches.filter(b=>submitted.has(b.requestId));
  const report={at:new Date().toISOString(),requested:this.products.size,submittedProducts:new Set(accepted.flatMap(b=>b.entries.map(e=>e.entry.listingId))).size,submittedAttempts:accepted.reduce((n,b)=>n+b.entries.length,0),captures:captures.length,capturedProducts:new Set(captures.map(c=>c.listing.externalId)).size,savedProducts:new Set(saved.map(r=>r.asin)).size,moduleReviewRecords:reviews,pricePoints:prices.filter(p=>p.newPrice!==null).length,comparablePricePoints:prices.filter(p=>p.difference!==null).length,priceChangeExamples:prices.filter(p=>p.difference!==null&&p.difference!==0).slice(0,10)};
  await this.save('temporal-prices.json',prices);await this.save('temporal-progress.json',report);return report;
 }
}
