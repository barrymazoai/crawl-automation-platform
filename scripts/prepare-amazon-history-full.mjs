// Mini: build the FULL Amazon recapture plan (every history listing not in the 2000 plan), one brand per legacy
// company as in prepare-amazon-history-batch.mjs, plus one catch-all brand for listings the legacy data cannot
// attribute to a company. Existing brands are reused by the legacy company id kept in their note; nothing is
// deleted or renamed. Outputs (retained, idempotent) under amazon-full-us-20260916/:
//   selection.json  price-baseline.json  ungrouped-candidates.jsonl  sources.json  link-batches.json  temporal-plan.json
// Run with --dry to only print the grouping statistics (no API calls, nothing written).
//   node prepare-amazon-history-full.mjs [--dry]
import fs from 'node:fs/promises';import {execFileSync} from 'node:child_process';import {randomUUID,createHash} from 'node:crypto';import pg from 'pg';import assert from 'node:assert/strict';import {hostname} from 'node:os';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);const dry=process.argv.includes('--dry');
const root='/Users/barry/apps/crawlv3-history-20260913',dir=root+'/amazon-full-us-20260916',prior=root+'/amazon-2000-us-20260913';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),hash=b=>createHash('sha256').update(b).digest('hex');
const retain=async(n,v)=>{const p=dir+'/'+n,b=typeof v==='string'?v:JSON.stringify(v,null,2);try{await fs.writeFile(p,b,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;assert.equal(await fs.readFile(p,'utf8'),b,'differs: '+p);}return p;};
const credentials=await read(root+'/admin.private.json'),db=new pg.Pool({connectionString:credentials.database.connectionString,max:2,connectionTimeoutMillis:5000,statement_timeout:180000});
const api=async(path,method='GET',body,key)=>{const r=await fetch('http://127.0.0.1:4188/api/v3'+path,{method,headers:{'X-V3-Client':'local-workspace',...(method!=='GET'?{'Origin':'http://127.0.0.1:4188','Content-Type':'application/json','Idempotency-Key':key}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});const j=await r.json().catch(()=>null);if(!r.ok)throw new Error(method+' '+path+' '+r.status+' '+JSON.stringify(j));return j;};
const NOTE_PREFIX='Amazon旧链接完整复采；分组名称来自旧库，不执行公司匹配；指定商品链接为partial范围，纽约10001。旧来源公司编号：';
const UNGROUPED='ungrouped',UNGROUPED_NAME='Amazon 未分组（旧库无公司）';
try{
 const priorPlan=await read(prior+'/temporal-plan.json'),priorAsins=new Set(priorPlan.products.map(p=>p.asin));
 const candidateBytes=await fs.readFile(root+'/reparse-candidates.jsonl'),candidates=new Map(candidateBytes.toString().trim().split('\n').map(JSON.parse).filter(c=>c.channel==='amazon'&&c.expected_listings.length===1&&c.expected_listings[0].basis==='external-id').map(c=>[c.expected_listings[0].externalId,c]));
 const companies=new Map(execFileSync('/opt/homebrew/bin/docker',['exec','quant-pg','psql','-U','postgres','-d','product_staging','-At','-c',"select json_build_object('id',id,'name',name) from company"],{encoding:'utf8',maxBuffer:10*1024*1024}).trim().split('\n').map(JSON.parse).map(c=>[c.id,c]));
 const listings=(await db.query("select l.external_id asin,l.listing_id from product_history_listing l where l.channel='amazon' and l.site='amazon.com' order by l.external_id")).rows;
 const rows=(await db.query("select l.external_id asin,l.listing_id,s.source_record_id,s.record->'product'->>'company_id' company_id,s.record->'product'->>'name' title,jsonb_array_length(s.record->'formulas') formulas from product_history_listing l join product_history_listing_source x using(listing_id) join product_history_source s using(source_record_id) where l.channel='amazon' and l.site='amazon.com' and s.dataset='mini:product_staging'")).rows;
 const byAsin=new Map();for(const r of rows){if(!byAsin.has(r.asin))byAsin.set(r.asin,[]);byAsin.get(r.asin).push(r);}
 const groups=new Map(),ungrouped=[];
 for(const {asin,listing_id} of listings){if(priorAsins.has(asin))continue;const rs=byAsin.get(asin)??[],c=candidates.get(asin),ids=new Set(rs.map(r=>r.company_id)),r=rs.find(r=>r.formulas>0)??rs[0];const co=ids.size===1?companies.get([...ids][0]):undefined;
  if(c&&r&&co&&co.name?.trim()&&co.name.length<=80&&c.expected_listings[0].listingId===r.listing_id){if(!groups.has(co.id))groups.set(co.id,{legacyCompanyId:co.id,name:co.name,products:[]});groups.get(co.id).products.push({asin,url:'https://www.amazon.com/dp/'+asin,historyListingId:r.listing_id,candidateId:c.candidateId,sourceRecordIds:rs.map(x=>x.source_record_id).sort(),title:r.title,hasLegacyFormula:r.formulas>0});}
  else ungrouped.push({asin,url:'https://www.amazon.com/dp/'+asin,historyListingId:listing_id,title:r?.title??null,hasLegacyFormula:!!(r&&r.formulas>0),reason:!rs.length?'no-legacy-record':ids.size!==1?'multiple-companies':!co?'unknown-company':!c?'no-candidate':'candidate-listing-mismatch'});}
 // The catch-all entries get their own retained candidate manifest so every batch entry still names a manifest line.
 const ungroupedManifest=ungrouped.map(u=>JSON.stringify({codec:'amazon-ungrouped-candidate/1',asin:u.asin,historyListingId:u.historyListingId,reason:u.reason})).join('\n')+'\n';
 for(const u of ungrouped)u.candidateId=hash(Buffer.from(JSON.stringify({codec:'amazon-ungrouped-candidate/1',asin:u.asin,historyListingId:u.historyListingId,reason:u.reason})));
 const ordered=[...groups.values()].sort((a,b)=>b.products.length-a.products.length||a.legacyCompanyId.localeCompare(b.legacyCompanyId));
 const stats={total:listings.length,excludedPriorPlan:priorAsins.size,grouped:ordered.reduce((s,g)=>s+g.products.length,0),companies:ordered.length,ungrouped:ungrouped.length,ungroupedByReason:ungrouped.reduce((m,u)=>(m[u.reason]=(m[u.reason]||0)+1,m),{})};
 console.log(JSON.stringify({event:'FULL_PLAN_STATS',...stats}));if(dry)process.exit(0);
 await fs.mkdir(dir,{recursive:true,mode:0o700});
 let plan;try{plan=await read(dir+'/selection.json');}catch(e){if(e.code!=='ENOENT')throw e;
  const mk=g=>({...g,brandRequest:randomUUID(),sourceRequest:randomUUID(),enableRequest:randomUUID(),batches:Array.from({length:Math.ceil(g.products.length/10)},(_,i)=>({requestId:randomUUID(),products:g.products.slice(i*10,i*10+10)}))});
  for(const g of ordered)g.products.sort((a,b)=>a.candidateId.localeCompare(b.candidateId));
  plan={codec:'amazon-history-selection/2',createdAt:new Date().toISOString(),count:stats.grouped+stats.ungrouped,region:'US',postalCode:'10001',candidateManifestSha256:hash(candidateBytes),ungroupedManifestSha256:hash(Buffer.from(ungroupedManifest)),selectionPolicy:'every amazon.com history listing outside the 2000 plan; one brand per legacy company where the legacy record, company and reparse candidate agree; the rest in one catch-all brand',stats,groups:[...ordered.map(mk),mk({legacyCompanyId:UNGROUPED,name:UNGROUPED_NAME,products:ungrouped})]};
  await retain('ungrouped-candidates.jsonl',ungroupedManifest);await retain('selection.json',plan);}
 const allAsins=plan.groups.flatMap(g=>g.products.map(p=>p.asin));assert.equal(new Set(allAsins).size,allAsins.length);
 try{await fs.access(dir+'/price-baseline.json');}catch{const baseline=(await db.query("select l.external_id asin,o.observation_id,o.observed_at,o.record from product_history_observation o join product_history_listing l using(listing_id) where l.external_id=ANY($1) and l.channel='amazon' and o.kind='metrics' order by l.external_id,o.observed_at",[allAsins])).rows;await retain('price-baseline.json',baseline);}
 // Existing brands (the 8 of the 2000 plan and any earlier) are found by the legacy company id in their note.
 const existing=new Map();for(let offset=0;;offset+=100){const page=await api('/brands?limit=100&offset='+offset);for(const b of page.items){const m=b.note?.match(/旧来源公司编号：([0-9a-f-]{36}|ungrouped)/);if(m&&!existing.has(m[1]))existing.set(m[1],b);}if(!page.hasMore)break;}
 const receipts=[],linkBatches=[];let created=0,reused=0;
 for(const g of plan.groups){
  let brand=existing.get(g.legacyCompanyId),source;
  if(brand){const sources=(await api('/brands/'+brand.id+'/sources')).items.filter(s=>s.channel==='amazon'&&s.region==='US');source=sources.find(s=>s.enabled)??sources[0];reused++;}
  else{brand=await api('/brands','POST',{name:g.name,note:NOTE_PREFIX+g.legacyCompanyId},g.brandRequest);created++;}
  if(!source)source=await api('/brands/'+brand.id+'/sources','POST',{channel:'amazon',region:'US',url:'https://www.amazon.com/'},g.sourceRequest);
  const enabled=source.enabled?source:await api('/brands/'+brand.id+'/sources/'+source.id+'/enabled','PATCH',{enabled:true,revision:source.revision},g.enableRequest);
  const scope={brandId:brand.id,sourceId:enabled.id,channel:'amazon',region:'US',rootUrl:enabled.url,scopeVersion:'source-revision-'+enabled.revision};
  receipts.push({legacyCompanyId:g.legacyCompanyId,name:g.name,products:g.products.length,brand,source:enabled});
  const manifestSha=g.legacyCompanyId===UNGROUPED?plan.ungroupedManifestSha256:plan.candidateManifestSha256;
  for(const b of g.batches)linkBatches.push({codec:'amazon-link-batch/1',requestId:b.requestId,scope,candidateManifestSha256:manifestSha,entries:b.products.map(p=>({entry:{listingId:p.asin,variantId:null,url:p.url,kind:'product'},candidateId:p.candidateId,historyListingId:p.historyListingId}))});
 }
 await retain('sources.json',receipts);await retain('link-batches.json',linkBatches);
 const products=plan.groups.flatMap(g=>g.products.map(p=>({asin:p.asin,url:p.url,historyListingId:p.historyListingId,candidateId:p.candidateId,title:p.title,hasLegacyFormula:p.hasLegacyFormula,legacyGroup:g.name})));
 await retain('temporal-plan.json',{codec:'amazon-full-plan/1',createdAt:plan.createdAt,region:'US',postalCode:'10001',productCount:products.length,products,batches:linkBatches});
 console.log(JSON.stringify({event:'FULL_PLAN_READY',dir,products:products.length,groups:plan.groups.length,brandsCreated:created,brandsReused:reused,batches:linkBatches.length}));
}finally{await db.end();}
