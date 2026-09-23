import {readFile} from "node:fs/promises";
import {beforeAll,afterAll,describe,it,expect} from "vitest";
import pg from "pg";
import {sha256} from "@crawl-automation/v3-artifacts";
import {ChannelPlanInputSchema} from "@crawl-automation/v3-contracts";
import {HistoryObservations,commerceMetrics} from "../src/history-observations.js";
import {MemoryObjects} from "../../../packages/v3-results/src/testing.fixture.js";
import {ProductHistory} from "../../v3-api/src/history/store.js";
import {convertHistoryInput,convertLegacyProduct,hash} from "../../v3-api/src/history/model.js";
import {labelProductFixture} from "../../../packages/v3-product/src/label-product.fixture.js";
import {labelCollectedHash} from "@crawl-automation/v3-product";
import {purchaseFixture} from '../../../packages/v3-channels/src/purchase-conditions.fixture.js';
import {productServiceMaterial} from '../../v3-api/src/history/product-service.js';
import {amazonFixture} from '../../../packages/v3-channels/src/amazon-live.fixture.js';
import {AmazonHtmlArchive} from '../../../packages/v3-channels/src/amazon-html-archive.js';

const address=process.env.V3_HISTORY_TEST_URL,s=()=>AbortSignal.timeout(10000);
describe.skipIf(!address)("Mini capture history integration",()=>{
 let db:pg.Pool,remote:MemoryObjects,history:HistoryObservations;const events:unknown[]=[];
 beforeAll(async()=>{
  if(process.env.V3_HISTORY_ISOLATED!=="true")throw Error("Isolated database required");
  db=new pg.Pool({connectionString:address,max:3});
  if((await db.query("SELECT current_database() name")).rows[0].name!=="crawler_v3_test"||(await db.query("SELECT to_regclass('public.product_history_source') t")).rows[0].t)throw Error("Empty isolated V3 database required");
  for(const n of ["018_product_history.sql","019_history_provenance_index.sql"])await db.query(await readFile(`${process.env.V3_HISTORY_SQL_ROOT}/${n}`,"utf8"));
  await db.query("CREATE TABLE collected_product(operation_id text PRIMARY KEY,record_hash text NOT NULL,record jsonb NOT NULL)");
  remote=new MemoryObjects();history=new HistoryObservations(db,remote,e=>events.push(e));
 });
 afterAll(async()=>{await db?.end();});
 const input=(id:string,price:string,variant="200")=>{
  const url="https://www.swansonvitamins.com/p/example-60-softgels",owner={schemaVersion:1,requestId:`request-${id}`,observationId:id,brandId:"brand",sourceId:"source",listingId:"100",variantId:variant};
  const projection={url,canonicalUrl:url,title:"Example 60",capturedAt:id==="first"?"2026-09-12T01:00:00Z":"2026-09-13T01:00:00Z",
   selectedForms:[{productId:"100",variantIds:[variant]}],gallery:[],sections:[],
   commerce:{codec:"public-product-commerce/1",sku:variant==="200"?"ABC001":null,price,currency:"USD",listPrice:null,rating:"4.8",reviewCount:"120",availability:"InStock",context:[]}};
  const bytes=Buffer.from(JSON.stringify(projection)),key=`v3/swanson-products/${id}/projection.json`;remote.data.set(key,bytes);
  return ChannelPlanInputSchema.parse({operationId:`plan-${id}`,owner,channel:"swanson",parserVersion:"swanson-rendered/1",expectedUrl:url,
   source:{schemaVersion:1,artifactId:`source-${id}`,observationId:id,sourceId:owner.sourceId,listingId:owner.listingId,variantId:owner.variantId,kind:"result-json",mediaType:"application/json",objectKey:key,byteSize:bytes.length,sha256:sha256(bytes),producer:{operationId:id,module:"swanson.browser-projection",implementationVersion:"swanson-rendered/1"}},
   binding:{sessionId:"session",egressId:"host/1"},text:{schemaVersion:1,module:"codex.text",implementationVersion:"codex-text/2",policyVersion:"anchored/2",resultSchemaVersion:2,configFingerprint:"a".repeat(64)},
   ocr:{schemaVersion:1,module:"ocr.file",implementationVersion:"1",policyVersion:"1",resultSchemaVersion:2,configFingerprint:"b".repeat(64)},visionConfigFingerprint:"c".repeat(64)});
 };
 it("links verified legacy SKU, appends new prices, and retains them with no label result",async()=>{
  const c=await db.connect();try{await new ProductHistory(c).append(convertLegacyProduct({codec:"legacy-product/1",dataset:"synthetic-old",kind:"product",product:{id:"old"},listings:[{row:{channel:"swanson",external_id:"ABC001",original_product_url:"https://www.swansonvitamins.com/products/example-60-softgels"},snapshots:[{captured_at:"2026-08-01T00:00:00Z",price:"20",currency:"USD"}]}],images:[],ingredients:[],formulas:[],formulaObservations:[]}));}finally{c.release();}
  const first=input("first","$22.00"),second=input("second","$24.00");
  await history.channel(first,s());await history.channel(first,s());await history.channel(second,s());
  expect((await db.query("SELECT count(*)::int n FROM product_history_listing")).rows[0].n).toBe(1);
  expect((await db.query("SELECT record->>'price' price FROM product_history_observation WHERE kind='metrics' ORDER BY observed_at")).rows).toEqual([{price:"20"},{price:"22.00"},{price:"24.00"}]);
  expect((await db.query("SELECT count(*)::int n FROM collected_product")).rows[0].n).toBe(0);
  const changed=input("first","$99.00");await expect(history.channel(changed,s())).rejects.toThrow("HISTORY.CAPTURE_RECEIPT_CONFLICT");
  expect((await db.query("SELECT count(*)::int n FROM product_history_observation")).rows[0].n).toBe(3);
 });
 it("keeps unverified selected variants separate and rejects corrupted evidence",async()=>{
  await history.channel(input("variant-a","5.00","201"),s());await history.channel(input("variant-b","6.00","202"),s());
  expect((await db.query("SELECT count(*)::int n FROM product_history_listing")).rows[0].n).toBe(3);
  const bad=input("tamper","8.00");remote.data.set(bad.source.objectKey,Buffer.from('{}'));
  await expect(history.channel(bad,s())).rejects.toThrow("HISTORY.EVIDENCE_CONFLICT");
 });
 it("keeps a durable receipt on database outage and can replay without browser or model",async()=>{
  const i=input("lost-ack","25.00"),failedDb={connect:async()=>{throw Error("synthetic DB outage");}} as unknown as pg.Pool;
  const outage=new HistoryObservations(failedDb,remote,e=>events.push(e));
  expect(await outage.attempt("channel",i,s())).toEqual({status:"pending"});
  expect(events).toContainEqual(expect.objectContaining({event:"HISTORY_PROJECTION_PENDING",observationId:"lost-ack"}));
  const key=`v3/history-observations/${hash(["v3:swanson","lost-ack"])}/capture.json`;
  expect(await history.replay(key,s())).toEqual({inserted:true});expect(await history.replay(key,s())).toEqual({inserted:false});
 });
 it("preserves old derived metrics on capture replay and corrects only fresh observations",async()=>{
  const old=input('old-metrics-format','7.99'),raw=JSON.parse(Buffer.from(remote.data.get(old.source.objectKey)!).toString());
  raw.commerce.reviewCount='(4,247)';raw.commerce.availability='In Stock';
  const bytes=Buffer.from(JSON.stringify(raw));remote.data.set(old.source.objectKey,bytes);old.source.byteSize=bytes.length;old.source.sha256=sha256(bytes);
  const key=`v3/history-observations/${hash(['v3:swanson',old.owner.observationId])}/capture.json`;
  const saved=await history.channel(old,s());expect(saved.metrics).toMatchObject({reviewCount:'4247',inStock:true});
  const historic={...saved,metrics:{...saved.metrics,reviewCount:null,inStock:null}};
  // Isolated fixture: seed a distinct historical observation with the previous decoder output.
  const legacyInput={...old,operationId:'plan-historical-decoder',owner:{...old.owner,observationId:'historical-decoder'},source:{...old.source,observationId:'historical-decoder'}};
  const prior={...historic,observationId:'historical-decoder',owner:legacyInput.owner,capture:{input:legacyInput,projection:raw}};
  const priorKey=`v3/history-observations/${hash(['v3:swanson','historical-decoder'])}/capture.json`;
  const priorBytes=Buffer.from(JSON.stringify(prior));remote.data.set(priorKey,priorBytes);
  const c=await db.connect();try{await new ProductHistory(c).append(convertHistoryInput(prior));}finally{c.release();}
  expect((await history.channel(legacyInput,s())).metrics).toMatchObject({reviewCount:null,inStock:null});
  expect(remote.data.get(priorKey)).toEqual(priorBytes);expect((await history.replay(key,s())).inserted).toBe(false);
 });
 it("preserves full collected label, associates capture time, and deduplicates formula registration",async()=>{
  const f=await labelProductFixture(),out=await f.assembly.run(f.join,s());expect(out.status).toBe("ready");
  expect((await f.collector.run({join:f.join,evidenceKey:out.evidenceKey},s())).status).toBe("collected");
  const record=[...f.collected.values()][0]!,owner=record.observation;
  await db.query("INSERT INTO collected_product VALUES($1,$2,$3)",[record.operationId,labelCollectedHash(record),record]);
  expect(await history.collected(record.operationId)).toEqual({status:"capture-pending"});
  const capture={codec:"v3-capture-history/1",dataset:"v3:gnc",observationId:owner.observationId,owner,capturedAt:"2026-09-12T04:00:00Z",listing:{channel:"gnc",url:"https://www.gnc.com/energy/613701.html",externalId:"613701"},metrics:commerceMetrics({price:"29.00"}),evidence:[{objectKey:"fixture/source",sha256:"f".repeat(64)}],capture:{fixture:true}};
  const c=await db.connect();try{await new ProductHistory(c).append(convertHistoryInput(capture));}finally{c.release();}
  expect(await history.collected(record.operationId)).toEqual({status:"saved",inserted:true});
  expect(await history.collected(record.operationId)).toEqual({status:"saved",inserted:false});
  const stored=(await db.query("SELECT observed_at,record FROM product_history_observation WHERE kind='formula'")).rows[0];
  expect(stored.observed_at.toISOString()).toBe(capture.capturedAt.replace('Z','.000Z'));expect(stored.record.collection).toEqual(record);
  expect((await db.query("SELECT record FROM collected_product WHERE operation_id=$1",[record.operationId])).rows[0].record).toEqual(record);
 });
 it("reads dated DTC retained harvest evidence and keeps unknown currency unknown",async()=>{
  const base=input("dtc-history","0"),url="https://brand.example/products/one",listingId=`dtc-${sha256(Buffer.from(url))}`,owner={...base.owner,observationId:"dtc-history",listingId,variantId:null};
  const key="v3/dtc-legacy/dtc-history",harvest=Buffer.from(JSON.stringify({counts:{discovered:1},startedAtMs:Date.parse("2026-09-13T02:00:00Z"),finishedAtMs:Date.parse("2026-09-13T02:00:05Z")}));
  const f={path:"harvest-result.json",objectKey:`${key}/files/harvest`,byteSize:harvest.length,sha256:sha256(harvest)};remote.data.set(f.objectKey,harvest);
  const manifestKey=`${key}/manifest.json`;remote.data.set(manifestKey,Buffer.from(JSON.stringify({url,files:[f]})));
  const projection={codec:"dtc-rendered/1",url,listingId,brandName:"Example",title:"One",sections:[],images:["https://brand.example/label.jpg"],selectedOnly:true,snapshotKeys:[manifestKey],legacy:{manifestKey,detailsHtml:"<h1>One</h1>",fields:{price:"34.50"},variants:[{variantId:"12345",price:"34.50"}],selectedVariant:null}};
  const bytes=Buffer.from(JSON.stringify(projection)),objectKey="v3/dtc-products/dtc-history/projection.json";remote.data.set(objectKey,bytes);
  const i={...base,channel:"dtc",parserVersion:"dtc-rendered/1",expectedUrl:url,owner,source:{...base.source,observationId:owner.observationId,listingId,variantId:null,objectKey,sha256:sha256(bytes),byteSize:bytes.length,producer:{operationId:"dtc-history",module:"dtc.browser-projection",implementationVersion:"dtc-rendered/1"}}};
  const result=await history.channel(i,s());expect(result.metrics.price).toBe("34.50");expect(result.metrics.currency).toBeNull();expect(result.capturedAt).toBe("2026-09-13T02:00:05.000Z");expect(result.listing.externalId).toBe("brand.example:shopify_variant:12345");
 });
 it("persists structured purchase conditions through database readback and immutable receipt replay",async()=>{
  const i=input('purchase-conditions','7.99'),raw=JSON.parse(Buffer.from(remote.data.get(i.source.objectKey)!).toString()),conditions=purchaseFixture();
  raw.commerce.purchaseConditions=conditions;const bytes=Buffer.from(JSON.stringify(raw));remote.data.set(i.source.objectKey,bytes);i.source.byteSize=bytes.length;i.source.sha256=sha256(bytes);
  const captured=await history.channel(i,s()),key=`v3/history-observations/${hash(['v3:swanson','purchase-conditions'])}/capture.json`;
  expect(await history.replay(key,s())).toEqual({inserted:false});
  const saved=(await db.query("SELECT record FROM product_history_source WHERE source_key=$1",['purchase-conditions'])).rows[0].record;
  expect(saved.metrics.extras.purchaseConditions).toEqual(conditions);expect(saved).toEqual(captured);
  const output=productServiceMaterial(convertHistoryInput(saved));expect((output.metrics[0] as any).items[0].extras.purchaseConditions).toEqual(conditions);
 });
 it('persists original Amazon HTML and qualified sales through database readback, rejecting corrupt originals',async()=>{
  const f=amazonFixture(),job=await f.job(),archive=new AmazonHtmlArchive(f.publication,job);
  const html=Buffer.from('<html><div id="socialProofingAsinFaceout_feature_div">1K+ bought in past month</div></html>');
  const original=await archive.save(html,s(),{capturedAt:f.product.capturedAt});
  const salesVolume={text:'1K+ bought in past month',lowerBound:'1000',approximate:true,period:'past_month',selector:'#socialProofingAsinFaceout_feature_div'};
  Object.assign(f.product,{originalHtml:original.source,commerce:{codec:'public-product-commerce/1',sku:null,price:'$7.99',currency:'USD',listPrice:null,rating:null,reviewCount:null,availability:'In Stock',context:[],salesVolume,priceStatus:'observed'}});
  const capture=await f.live.capture(job,s());for(const [key,bytes] of f.remote.data)remote.data.set(key,bytes);
  const result=await history.channel(capture.sourcePlan,s()),id=capture.sourcePlan.owner.observationId;
  expect(result.evidence).toContainEqual({objectKey:original.source.objectKey,sha256:sha256(html)});
  expect(result.metrics).toMatchObject({price:'7.99',unitsSold:'1000',unitsSoldPeriod:'trailing_30d'});
  const saved=(await db.query('SELECT record FROM product_history_source WHERE source_key=$1',[id])).rows[0].record;
  expect(saved).toEqual(result);expect(saved.metrics.extras.salesVolume).toEqual(salesVolume);
  const receipt=`v3/history-observations/${hash(['v3:amazon',id])}/capture.json`;
  expect(await history.replay(receipt,s())).toEqual({inserted:false});
  const count=(await db.query('SELECT count(*)::int n FROM product_history_source')).rows[0].n;
  remote.data.set(original.source.objectKey,Buffer.from('corrupted'));
  await expect(history.channel(capture.sourcePlan,s())).rejects.toThrow('HISTORY.EVIDENCE_CONFLICT');
  expect((await db.query('SELECT count(*)::int n FROM product_history_source')).rows[0].n).toBe(count);
  remote.data.set(original.source.objectKey,html);
 });
 it("reads only the exact GNC SKU offer from retained HTML",async()=>{
  const owner={schemaVersion:1,requestId:"gnc-metric",observationId:"gnc-metric",brandId:"brand",sourceId:"source",listingId:"123456",variantId:null};
  const task={schemaVersion:1,implementationVersion:"gnc-acquire/1",owner,network:{routeId:"fixture-direct",version:"1",egressId:"direct/1",mode:"direct",managed:true},capture:{kind:"product",requestId:owner.requestId,operationId:"gnc-metric",brandId:owner.brandId,sourceId:owner.sourceId,binding:{sessionId:"session",egressId:"direct/1"},url:"https://www.gnc.com/energy/123456.html",sku:"123456"}};
  const html=Buffer.from('<script type="application/ld+json">'+JSON.stringify([{'@type':'Product',sku:'wrong',offers:{price:'1',priceCurrency:'USD'}},{'@type':'Product',sku:'123456',offers:{price:'19.95',priceCurrency:'USD',availability:'https://schema.org/InStock'},aggregateRating:{ratingValue:'4.5',reviewCount:120}}])+'</script>');
  const source={schemaVersion:1,artifactId:"gnc-source",observationId:owner.observationId,sourceId:owner.sourceId,listingId:owner.listingId,variantId:null,kind:"source-html",mediaType:"text/html",objectKey:"v3/gnc/gnc-metric/source.html",byteSize:html.length,sha256:sha256(html),producer:{operationId:"gnc-metric",module:"gnc.capture",implementationVersion:"gnc-acquire/1"}};
  remote.data.set(source.objectKey,html);remote.data.set("v3/gnc/gnc-metric/received.json",Buffer.from(JSON.stringify({codec:"gnc-received/1",schemaVersion:1,input:task,nonce:"00000000-0000-4000-8000-000000000001",receivedAt:"2026-09-13T03:00:00Z",source})));
  const result=await history.gnc(task,s());expect(result?.metrics).toMatchObject({price:"19.95",currency:"USD",rating:"4.5",reviewCount:"120",inStock:true});
 });
});
