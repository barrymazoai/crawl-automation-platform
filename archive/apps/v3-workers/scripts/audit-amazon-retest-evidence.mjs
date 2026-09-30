// Mini-only read-only evidence audit. No browser, provider, task submission or R2 writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import pg from 'pg';
const [batchDir,output,helper]=process.argv.slice(2);
assert.equal(process.platform,'darwin');assert.ok(batchDir&&output&&helper);
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const plan=await read(batchDir+'/temporal-plan.json'),config=await read(batchDir+'/amazon.private.json');
assert.equal(plan.productCount,10);const ids=plan.batches.map(b=>b.requestId);
const {createR2Objects}=await import(helper),remote=createR2Objects(config.r2,config.r2Credentials);
const db=new pg.Pool({connectionString:config.database.connectionString,max:1,statement_timeout:10000,options:'-c default_transaction_read_only=on'});
await fs.mkdir(output,{recursive:true,mode:0o700});
const keep=(name,v)=>fs.writeFile(path.join(output,name),typeof v==='string'||v instanceof Uint8Array?v:JSON.stringify(v,null,2),{flag:'wx',mode:0o600});
try{
 const captures=(await db.query("SELECT record FROM product_history_source WHERE dataset='v3:amazon' AND record->>'codec'='v3-capture-history/1' AND record->'owner'->>'requestId'=ANY($1)",[ids])).rows.map(r=>r.record);
 const reviews=(await db.query("SELECT record FROM review_record WHERE record->'observation'->>'requestId'=ANY($1)",[ids])).rows.map(r=>r.record);
 const results=(await db.query('SELECT record FROM processing_result WHERE record::text LIKE ANY($1)',[ids.map(id=>'%'+id+'%')])).rows.map(r=>r.record);
 await keep('records.json',{captures,reviews,results});
 const refs=new Map();
 function walk(v){if(!v||typeof v!=='object')return;if(typeof v.objectKey==='string'&&typeof v.sha256==='string'&&Number.isInteger(v.byteSize)){
  const prior=refs.get(v.objectKey);if(prior)assert.equal(prior.sha256,v.sha256);else refs.set(v.objectKey,v);
 }for(const x of Object.values(v))walk(x);}
 walk({captures,reviews,results});
 const artifacts=[];
 for(const ref of refs.values()){
  if(ref.byteSize>16*1024*1024)throw Error('AUDIT.SIZE_LIMIT');
  const b=await remote.store.read(ref.objectKey,Math.max(ref.byteSize,1),AbortSignal.timeout(60000));
  assert.ok(b);assert.equal(b.length,ref.byteSize);assert.equal(createHash('sha256').update(b).digest('hex'),ref.sha256);
  const ext=ref.mediaType==='image/jpeg'?'.jpg':ref.mediaType==='image/png'?'.png':ref.mediaType==='image/webp'?'.webp':ref.mediaType==='application/json'?'.json':'.txt';
  const file=ref.sha256+ext;
  if(!artifacts.some(a=>a.file===file))await keep(file,b);
  artifacts.push({file,ref});
 }
 await keep('artifacts.json',artifacts);
 console.log(JSON.stringify({output,captures:captures.length,reviews:reviews.length,results:results.length,artifacts:artifacts.length,
  summary:reviews.map(r=>({asin:r.observation.listingId,stage:r.failure.stage,code:r.failure.code,candidate:r.candidate?.value??null,detailsKeys:Object.keys(r.rawError?.details??{})})),
  purchase:captures.map(c=>({asin:c.listing.externalId,variants:c.capture.projection.variants,variantControls:c.capture.projection.variantControls,evidence:c.metrics.extras?.purchaseConditions?.evidence??c.metrics.extras?.commerce?.purchaseConditions?.evidence}))}));
}finally{await db.end();remote.close();}
