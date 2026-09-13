import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import assert from 'node:assert/strict';
const root='/Users/barry/apps/crawlv3-history-20260913',dir=root+'/amazon-2000-us-20260913',main='/Users/barry/apps/crawlv3-batch-a.UiA4dx';
assert.equal(process.platform,'darwin');
await fs.mkdir(dir,{recursive:true,mode:0o700});
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const retain=async(n,v)=>{const p=dir+'/'+n,b=JSON.stringify(v,null,2);try{await fs.writeFile(p,b,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;assert.equal(await fs.readFile(p,'utf8'),b);}return p;};
const credentials=await read(root+'/admin.private.json'),db=new pg.Pool({connectionString:credentials.database.connectionString,max:2,connectionTimeoutMillis:5000,statement_timeout:30000});
const api=async(path,method='GET',body,key)=>{const r=await fetch('http://127.0.0.1:4188/api/v3'+path,{method,headers:{'X-V3-Client':'local-workspace',...(method!=='GET'?{'Origin':'http://127.0.0.1:4188','Content-Type':'application/json','Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});const v=await r.json();if(!r.ok)throw Error('API '+r.status+' '+JSON.stringify(v));return v;};
try{
 let plan;try{plan=await read(dir+'/selection.json');}catch(e){if(e.code!=='ENOENT')throw e;
  const candidateBytes=await fs.readFile(root+'/reparse-candidates.jsonl'),candidates=new Map(candidateBytes.toString().trim().split('\n').map(JSON.parse).filter(c=>c.channel==='amazon'&&c.expected_listings.length===1&&c.expected_listings[0].basis==='external-id').map(c=>[c.expected_listings[0].externalId,c]));
  const companies=new Map(execFileSync('/opt/homebrew/bin/docker',['exec','quant-pg','psql','-U','postgres','-d','product_staging','-At','-c',"select json_build_object('id',id,'name',name) from company"],{encoding:'utf8',maxBuffer:10*1024*1024}).trim().split('\n').map(JSON.parse).map(c=>[c.id,c]));
  const rows=(await db.query("select l.external_id asin,l.listing_id,s.source_record_id,s.record->'product'->>'company_id' company_id,s.record->'product'->>'name' title,jsonb_array_length(s.record->'formulas') formulas from product_history_listing l join product_history_listing_source x using(listing_id) join product_history_source s using(source_record_id) where l.channel='amazon' and l.site='amazon.com' and s.dataset='mini:product_staging'")).rows;
  const byAsin=new Map();for(const r of rows){if(!byAsin.has(r.asin))byAsin.set(r.asin,[]);byAsin.get(r.asin).push(r);}
  const groups=new Map();for(const [asin,rs] of byAsin){const c=candidates.get(asin),ids=new Set(rs.map(r=>r.company_id)),r=rs.find(r=>r.formulas>0);if(!c||!r||ids.size!==1||!companies.has(r.company_id)||c.expected_listings[0].listingId!==r.listing_id)continue;
   const company=companies.get(r.company_id);if(!company.name?.trim()||company.name.length>80)continue;
   if(!groups.has(company.id))groups.set(company.id,{legacyCompanyId:company.id,name:company.name,products:[]});
   groups.get(company.id).products.push({asin,url:'https://www.amazon.com/dp/'+asin,historyListingId:r.listing_id,candidateId:c.candidateId,sourceRecordIds:rs.map(x=>x.source_record_id).sort(),title:r.title,hasLegacyFormula:true});
  }
  const chosen=[];let remaining=2000;for(const g of [...groups.values()].sort((a,b)=>b.products.length-a.products.length||a.legacyCompanyId.localeCompare(b.legacyCompanyId))){if(!remaining)break;g.products.sort((a,b)=>a.candidateId.localeCompare(b.candidateId));g.products=g.products.slice(0,remaining);remaining-=g.products.length;chosen.push({...g,brandRequest:randomUUID(),sourceRequest:randomUUID(),enableRequest:randomUUID(),batches:Array.from({length:Math.ceil(g.products.length/4)},(_,i)=>({requestId:randomUUID(),products:g.products.slice(i*4,i*4+4)}))});}
  assert.equal(remaining,0);assert.equal(new Set(chosen.flatMap(g=>g.products.map(p=>p.asin))).size,2000);
  plan={codec:'amazon-history-selection/1',createdAt:new Date().toISOString(),count:2000,region:'US',postalCode:'10001',candidateManifestSha256:hash(candidateBytes),selectionPolicy:'largest legacy brand groups; known formula; one unambiguous history listing and legacy company; deterministic candidateId order',oldSourceUpdateRequest:randomUUID(),groups:chosen};await retain('selection.json',plan);
 }
 const baseline=(await db.query("select l.external_id asin,o.observation_id,o.observed_at,o.record from product_history_observation o join product_history_listing l using(listing_id) where l.external_id=ANY($1) and l.channel='amazon' and o.kind='metrics' order by l.external_id,o.observed_at",[plan.groups.flatMap(g=>g.products.map(p=>p.asin))])).rows;
 try{await fs.access(dir+'/price-baseline.json');}catch{await retain('price-baseline.json',baseline);}
 const receipts=[],linkBatches=[];
 for(const g of plan.groups){
  const brand=await api('/brands','POST',{name:g.name,note:'Amazon旧链接完整复采；分组名称来自旧库，不执行公司匹配；指定商品链接为partial范围，纽约10001。旧来源公司编号：'+g.legacyCompanyId},g.brandRequest);
  const source=await api('/brands/'+brand.id+'/sources','POST',{channel:'amazon',region:'US',url:'https://www.amazon.com/'},g.sourceRequest);
  const enabled=await api('/brands/'+brand.id+'/sources/'+source.id+'/enabled','PATCH',{enabled:true,revision:source.revision},g.enableRequest);
  const scope={brandId:brand.id,sourceId:source.id,channel:'amazon',region:'US',rootUrl:source.url,scopeVersion:'source-revision-'+enabled.revision};
  receipts.push({legacyCompanyId:g.legacyCompanyId,brand,source:enabled});
  for(const b of g.batches)linkBatches.push({codec:'amazon-link-batch/1',requestId:b.requestId,scope,candidateManifestSha256:plan.candidateManifestSha256,entries:b.products.map(p=>({entry:{listingId:p.asin,variantId:null,url:p.url,kind:'product'},candidateId:p.candidateId,historyListingId:p.historyListingId}))});
 }
 await retain('sources.json',receipts);await retain('link-batches.json',linkBatches);
 const manifest=await read(main+'/live/deployment.json'),old=await read(manifest.jobs.find(j=>j.id==='amazon-capture').env.V3_AMAZON_LIVE_CONFIG);
 const existing=(await api('/brands/'+old.scope.brandId+'/sources')).items.find(s=>s.id===old.scope.sourceId);assert.ok(existing);
 let current=existing;if(existing.region!=='US')current=await api('/brands/'+old.scope.brandId+'/sources/'+old.scope.sourceId,'PUT',{channel:'amazon',region:'US',url:existing.url,revision:existing.revision},plan.oldSourceUpdateRequest);
 const config={...old,scope:{...old.scope,region:'US',scopeVersion:'source-revision-'+current.revision},deliveryPostalCode:'10001',linkBatches};
 await retain('amazon-before.private.json',old);await retain('amazon.private.json',config);
 console.log(JSON.stringify({dir,count:plan.count,groups:plan.groups.length,batches:linkBatches.length,region:plan.region,postalCode:plan.postalCode,manifestSha256:hash(Buffer.from(JSON.stringify(plan))),baselinePoints:baseline.length,submitted:0}));
}finally{await db.end();}
