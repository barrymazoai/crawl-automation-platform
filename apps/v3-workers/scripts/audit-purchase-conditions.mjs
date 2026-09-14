// Run on Mini after build-purchase-conditions.ts and the isolated integration suite.
// Production stores are read-only. Real DOM samples are persisted only to the owned test database.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import pg from 'pg';
const [work,settingsPath,testUrl]=process.argv.slice(2);
assert.equal(process.platform,'darwin');
const url=new URL(testUrl);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'32817');assert.equal(url.pathname,'/crawler_v3_test');
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const lib=await import(path.join(work,'candidate/acceptance/purchase-conditions-inspect.js'));
const config=await read(settingsPath),r2=lib.createR2Objects(config.r2,config.r2Credentials);
const db=new pg.Pool({connectionString:config.database.connectionString,max:1,statement_timeout:10000,options:'-c default_transaction_read_only=on'});
const test=new pg.Pool({connectionString:testUrl,max:1,statement_timeout:10000});
const forbidden=async()=>{throw Error('AUDIT.WRITE_FORBIDDEN');};
const remote={read:r2.store.read.bind(r2.store),create:forbidden};
const local={read:async()=>null,create:forbidden,retain:forbidden};
const plans=new lib.ChannelProductPlans(new lib.RetainedPublication(local,remote),new lib.ArtifactResolver(local,remote),{read:async()=>null,append:forbidden});
try{
 const rows=(await db.query("SELECT source_record_id,body_hash,record FROM product_history_source WHERE dataset='v3:amazon' AND record->>'codec'='v3-capture-history/1' ORDER BY source_record_id")).rows;
 assert.ok(rows.length>=23);let inspected=0;
 for(const row of rows){
  const converted=lib.convertHistoryInput(row.record);
  assert.equal(converted.id,row.source_record_id);assert.equal(converted.bodyHash,row.body_hash);
  assert.deepEqual(lib.commerceMetrics(row.record.capture.projection.commerce),row.record.metrics);
  assert.equal(row.record.metrics.extras.purchaseConditions,undefined);
  const plan=await plans.inspect(row.record.capture.input,AbortSignal.timeout(30000));assert.ok(plan);inspected++;
 }
 const samples=[];
 for(const asin of ['B0GHZ3X54Z','B0C296MRW4']){
  const file=path.join(work,'browser-acceptance',asin+'.json'),bytes=await fs.readFile(file),sample=JSON.parse(bytes);
  const conditions=lib.PurchaseConditionsSchema.parse(sample.commerce.purchaseConditions),metrics=lib.commerceMetrics(sample.commerce);
  assert.equal(conditions.delivery.postalCode,'10001');assert.ok(conditions.seller.name);assert.equal(conditions.quantity,1);assert.equal(conditions.priceScope,'selected_offer');
  const raw={codec:'v3-capture-history/1',dataset:'v3:amazon',observationId:'purchase-conditions-diagnostic-'+asin,owner:{diagnostic:true},capturedAt:sample.at,
   listing:{channel:'amazon',url:sample.url,externalId:asin},metrics,
   evidence:[{objectKey:'diagnostic-local/'+asin+'.json',sha256:createHash('sha256').update(bytes).digest('hex')}],capture:{diagnostic:true,sourcePath:file,projection:sample}};
  const value=lib.convertHistoryInput(raw),client=await test.connect();
  try{const history=new lib.ProductHistory(client);await history.append(value);await history.verify([value]);}finally{client.release();}
  const saved=(await test.query('SELECT record FROM product_history_source WHERE source_record_id=$1',[value.id])).rows[0].record;
  assert.deepEqual(saved,raw);
  const item=lib.productServiceMaterial(lib.convertHistoryInput(saved)).metrics[0].items[0];assert.deepEqual(item.extras.purchaseConditions,conditions);
  samples.push({asin,price:metrics.price,currency:metrics.currency,purchaseType:conditions.purchaseType,seller:conditions.seller.name,shipsFrom:conditions.shipsFrom,quantity:conditions.quantity,postalCode:conditions.delivery.postalCode,promotions:conditions.promotions.length,isolatedDatabaseReadback:true,exportPreserved:true});
 }
 const cleanup=await read(path.join(work,'browser-acceptance/closed-proof.json'));assert.equal(cleanup.targetsAbsent,true);
 const report={at:new Date().toISOString(),passed:true,oldSourcesUnchanged:rows.length,oldDurablePlansVerified:inspected,productionReadOnly:true,realBrowserSamples:samples,targetsAbsent:true,productionObservationsSubmitted:0};
 await fs.writeFile(path.join(work,'acceptance.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
}finally{await db.end();await test.end();r2.close();}
