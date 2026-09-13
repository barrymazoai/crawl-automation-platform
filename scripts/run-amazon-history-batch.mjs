import fs from 'node:fs/promises';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import assert from 'node:assert/strict';import pg from 'pg';
const root='/Users/barry/apps/crawlv3-history-20260913',dir=root+'/amazon-2000-us-20260913';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),sleep=ms=>new Promise(r=>setTimeout(r,ms));
assert.equal(process.platform,'darwin');const mode=process.argv[2]??'pilot';assert.ok(['pilot','run','status'].includes(mode));
const plan=await read(dir+'/selection.json'),originalBatches=await read(dir+'/link-batches.json'),baseline=await read(dir+'/price-baseline.json');
let retries=[];try{retries=await read(dir+'/retry-batches.json');}catch(e){if(e.code!=='ENOENT')throw e;}
const batches=[...originalBatches.slice(0,2),...retries,...originalBatches.slice(2)];assert.equal(new Set(batches.map(b=>b.requestId)).size,batches.length);
const cfg=await read(root+'/admin.private.json'),db=new pg.Pool({connectionString:cfg.database.connectionString,max:1,connectionTimeoutMillis:5000,statement_timeout:10000,options:'-c default_transaction_read_only=on'});
const ids=batches.map(b=>b.requestId),products=plan.groups.flatMap(g=>g.products.map(p=>({...p,brand:g.name}))),byAsin=new Map(products.map(p=>[p.asin,p]));
const atomic=async(name,v)=>{const p=dir+'/'+name;const tmp=p+'.'+process.pid+'.next';await fs.writeFile(tmp,JSON.stringify(v,null,2),{mode:0o600});await fs.rename(tmp,p);};
const event=async e=>fs.appendFile(dir+'/batch-events.jsonl',JSON.stringify({at:new Date().toISOString(),...e})+'\n',{mode:0o600});
const api=async(path,method='GET',body,key)=>{const r=await fetch('http://127.0.0.1:4188/api/v3'+path,{method,signal:AbortSignal.timeout(15000),headers:{'X-V3-Client':'local-workspace',...(method!=='GET'?{Origin:'http://127.0.0.1:4188','Content-Type':'application/json','Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});const v=await r.json();if(!r.ok){const e=Error('API '+r.status+' '+JSON.stringify(v));e.status=r.status;throw e;}return v;};
async function report(){
 const captures=(await db.query("select record from product_history_source where dataset='v3:amazon' and record->>'codec'='v3-capture-history/1' and record->'owner'->>'requestId'=ANY($1)",[ids])).rows.map(r=>r.record);
 const saved=(await db.query("select record->'observation'->>'listingId' asin from collected_product where record->'observation'->>'requestId'=ANY($1)",[ids])).rows;
 const submissions=(await db.query("select request_id from collection_submission where request_id::text=ANY($1)",[ids])).rows;
 const reviews=(await db.query("select record->'observation'->>'listingId' asin,record->'failure'->>'code' code from review_record where record->'observation'->>'requestId'=ANY($1)",[ids])).rows;
 const prices=captures.map(c=>{const asin=c.listing.externalId,p=byAsin.get(asin),old=baseline.filter(x=>x.asin===asin&&x.observed_at&&x.record.price!==null&&x.record.price!==undefined&&String(x.record.price).trim()!==''&&Number.isFinite(Number(x.record.price))&&Date.parse(x.observed_at)<Date.parse(c.capturedAt)).sort((a,b)=>Date.parse(b.observed_at)-Date.parse(a.observed_at))[0];const oldPrice=old?.record.price??null,newPrice=c.metrics.price,oldCurrency=old?.record.currency??null,newCurrency=c.metrics.currency;
  const comparable=oldPrice!==null&&newPrice!==null&&oldCurrency!==null&&oldCurrency===newCurrency;return{asin,title:c.capture?.projection?.title??p?.title,legacyGroup:p?.brand,brandRaw:c.capture?.projection?.brandRaw??null,url:p?.url,oldAt:old?.observed_at??null,oldPrice,oldCurrency,newAt:c.capturedAt,newPrice,newCurrency,delivery:'New York 10001',difference:comparable?Number((Number(newPrice)-Number(oldPrice)).toFixed(4)):null,changePercent:comparable&&Number(oldPrice)>0?Number(((Number(newPrice)/Number(oldPrice)-1)*100).toFixed(2)):null,comparisonNote:comparable?'页面报价差异；旧购买条件未完整记录，不代表同条件成交价格变化':'缺少价格或明确一致的币种；不计算涨跌',newContext:c.metrics.extras,observationId:c.observationId};});
 const submitted=new Set(submissions.map(s=>s.request_id)),summary={at:new Date().toISOString(),requested:2000,submittedProducts:new Set(batches.filter(b=>submitted.has(b.requestId)).flatMap(b=>b.entries.map(e=>e.entry.listingId))).size,submittedAttempts:batches.filter(b=>submitted.has(b.requestId)).reduce((n,b)=>n+b.entries.length,0),captures:captures.length,capturedProducts:new Set(captures.map(c=>c.listing.externalId)).size,savedProducts:new Set(saved.map(r=>r.asin)).size,moduleReviewRecords:reviews.length,pricePoints:prices.filter(p=>p.newPrice!==null).length,comparablePricePoints:prices.filter(p=>p.difference!==null).length,priceChangeExamples:prices.filter(p=>p.difference!==null&&p.difference!==0).slice(0,10)};
 await atomic('prices.json',prices);await atomic('progress.json',summary);return summary;
}
async function recoverClosedPage(batch){
 if(process.env.V3_RECOVER_CLOSED_PAGES!=='1')return;
 const held=(await db.query("select p.permit_id from resource_permit p join catalog_discovery d on d.record->>'workflowId'=p.request->>'workflowId' join review_record r on r.record->'observation'->>'requestId'=d.catalog_id and r.record->'observation'->>'listingId'=d.record->'entry'->>'listingId' where p.released_at is null and d.catalog_id=$1 and r.record->'failure'->>'stage' in ('amazon.browser','channel.product-input') and (r.record->>'occurredAt')::timestamptz<now()-interval '30 seconds'",[batch.requestId])).rows;
 if(!held.length)return;assert.equal(held.length,1);
 const helper=root+'/amazon-2000-tools/amazon-recovery-v3/recover-amazon-history-pilot.js';
 await event({event:'RECOVERY_PROOF_CHECK',requestId:batch.requestId,permitId:held[0].permit_id});
 try{
  const out=await promisify(execFile)(process.execPath,[helper,'--release'],{timeout:120000,maxBuffer:1024*1024});
  const receipt=JSON.parse(out.stdout.trim());assert.equal(receipt.status,'released');assert.equal(receipt.requestId,batch.requestId);assert.equal(receipt.request.permitId,held[0].permit_id);
  await event({event:'CLOSED_PAGE_PERMIT_RECOVERED',requestId:batch.requestId,permitId:held[0].permit_id,proofKey:receipt.proofKey});
 }catch(error){
  await atomic('recovery-failure-'+held[0].permit_id+'.json',{at:new Date().toISOString(),stdout:error.stdout??'',stderr:error.stderr??'',error:String(error)});
  throw Error('BATCH.PAGE_RECOVERY_UNVERIFIED; retained diagnostic; no further submissions');
 }
}
let lock,stop=false;process.once('SIGTERM',()=>{stop=true;});process.once('SIGINT',()=>{stop=true;});
try{
 if(mode==='status'){console.log(JSON.stringify(await report()));}
 else{
  lock=await fs.open(dir+'/batch-runner.lock','wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString(),mode}));await lock.close();
  const deployment=await read(dir+'/deployment-result.json');assert.equal(deployment.ready,90);
  const limit=process.env.V3_BATCH_LIMIT?Number(process.env.V3_BATCH_LIMIT):mode==='pilot'?1:batches.length;assert.ok(Number.isInteger(limit)&&limit>=1&&limit<=batches.length);
  for(let index=0;index<limit;index++){
   if(stop)break;try{await fs.access(dir+'/PAUSE');await event({event:'PAUSED_BY_FILE',index});break;}catch(e){if(e.code!=='ENOENT')throw e;}
   const b=batches[index],path=dir+'/submission-'+b.requestId+'.json';let submission;
   try{submission=await api('/submissions/'+b.requestId);}catch(e){if(e.status!==404)throw e;
    const healthy=(await db.query("select resource_id,healthy,health_until>now() fresh from resource_capacity where resource_id=ANY($1)",[['mini-ego-space-1','mini-model-account','windows-ocr']])).rows;assert.equal(healthy.length,3);assert.ok(healthy.every(r=>r.healthy&&r.fresh),'dependencies must be healthy before new submission');
    await event({event:'SUBMIT_INTENT',index,requestId:b.requestId,asins:b.entries.map(e=>e.entry.listingId)});
    submission=await api('/brands/'+b.scope.brandId+'/sources/'+b.scope.sourceId+'/submissions','POST',{sourceRevision:Number(b.scope.scopeVersion.replace('source-revision-',''))},b.requestId);
   }
   assert.equal(submission.requestId,b.requestId);assert.equal(submission.snapshot.region,'US');assert.equal(submission.snapshot.sourceId,b.scope.sourceId);
   await atomic('submission-'+b.requestId+'.json',submission);await event({event:'SUBMITTED_OR_RECONCILED',index,requestId:b.requestId,workflowId:submission.workflowId});
   let completed=false;while(!stop){const d=(await api('/submissions/'+b.requestId+'/delivery')).item;
    await recoverClosedPage(b);const progress=await report();await atomic('runner-status.json',{...progress,pid:process.pid,index,requestId:b.requestId,workflowId:submission.workflowId,delivery:d?.state,workflowStatus:d?.observedStatus});
    if(d?.state==='CLOSED'){assert.equal(d.observedStatus,'COMPLETED');completed=true;await atomic('terminal-'+b.requestId+'.json',d);break;}
    if(d?.observedStatus&& !['RUNNING','CONTINUED_AS_NEW'].includes(d.observedStatus))throw Error('BATCH.TERMINAL_UNVERIFIED');
    await sleep(10000);
   }
   if(!completed)break;
   const discoveries=(await db.query('select record from catalog_discovery where catalog_id=$1',[b.requestId])).rows.map(r=>r.record);assert.equal(discoveries.length,b.entries.length,'all selected links must dispatch');
   assert.deepEqual(discoveries.map(d=>d.entry.listingId).sort(),b.entries.map(e=>e.entry.listingId).sort());
   const held=(await db.query("select count(*)::int n from resource_permit where released_at is null and request->>'workflowId'=ANY($1)",[discoveries.flatMap(d=>[d.workflowId,d.workflowId+'-label'])])).rows[0].n;assert.equal(held,0,'no quarantined permit before next batch');
   await event({event:'BATCH_COMPLETED',index,requestId:b.requestId,count:b.entries.length});console.log(JSON.stringify({event:'BATCH_COMPLETED',index,...await report()}));
  }
  console.log(JSON.stringify({event:stop?'RUNNER_STOPPED':'RUNNER_LIMIT_REACHED',...await report()}));
 }
}catch(e){await event({event:'RUNNER_PAUSED',error:String(e)});console.error(String(e));process.exitCode=1;}
finally{await db.end();if(lock)await fs.unlink(dir+'/batch-runner.lock');}
