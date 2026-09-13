import {isDeepStrictEqual as equal} from "node:util";
import type pg from "pg";
import {z} from "zod";
import {ChannelPlanInputSchema,GncAcquireInputSchema,GncReceivedRecordSchema,LabelCollectedProductSchema,assertArtifactBelongsTo,
  type ArtifactRef} from "@crawl-automation/v3-contracts";
import {sha256,type ObjectStore} from "@crawl-automation/v3-artifacts";
import {parseAmazonRenderedProduct,parseSwansonRenderedProduct,parseDtcRenderedProduct} from "@crawl-automation/v3-channels";
import {labelCollectedHash} from "@crawl-automation/v3-product";
import {CaptureHistorySchema,convertHistoryInput,decimal,hash,text,timestamp,type CaptureHistory,type Row} from "../../v3-api/src/history/model.js";
import {ProductHistory} from "../../v3-api/src/history/store.js";

const decode=(b:Uint8Array)=>JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(b));
const asRow=(v:unknown):Row=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Row:{};
const emptyMetrics=():CaptureHistory["metrics"]=>({price:null,currency:null,listPrice:null,rating:null,reviewCount:null,salesRank:null,inStock:null,unitsSold:null,unitsSoldPeriod:null,extras:null});
const currency=(v:unknown)=>{const s=text(v)?.toUpperCase();return s&&/^[A-Z]{3}$/.test(s)?s:null;};
function amount(v:unknown){const s=text(v);if(!s)return decimal(v);return decimal(s.replace(/^(?:US\$|USD\s*|\$|£|€)\s*/u,"").replace(/(?<=\d),(?=\d{3}(?:,|\.|$))/gu,""));}
function stock(v:unknown):boolean|null{if(typeof v==="boolean")return v;const s=text(v);if(!s)return null;if(/^(?:https?:\/\/schema.org\/)?InStock\.?$/i.test(s.trim()))return true;if(/^(?:https?:\/\/schema.org\/)?(?:OutOfStock|SoldOut)$/i.test(s.trim()))return false;return null;}
export function commerceMetrics(raw:unknown){
  const r=asRow(raw),m=emptyMetrics();
  m.price=amount(r.price);m.listPrice=amount(r.listPrice);m.currency=currency(r.currency);
  m.rating=decimal(r.rating)??decimal(text(r.rating)?.match(/^(\d+(?:\.\d+)?)\s+out of\s+5\s+stars$/i)?.[1]);
  m.reviewCount=decimal(r.reviewCount)??decimal(text(r.reviewCount)?.match(/^([\d,]+)\s+(?:ratings|reviews)$/i)?.[1]?.replaceAll(",",""));
  m.inStock=stock(r.availability);m.extras={commerce:r};return m;
}

/** Mini-only projection of retained evidence. Does not navigate or call OCR/models. */
export class HistoryObservations{
  constructor(readonly db:pg.Pool,readonly remote:ObjectStore,readonly report:(event:Row)=>void=e=>console.log(JSON.stringify(e))){}
  async check(){
    if(!['crawler_v3_dev','crawler_v3_test'].includes((await this.db.query("SELECT current_database() name")).rows[0]?.name))throw Error("HISTORY.DATABASE_REJECTED");
    for(const table of ['product_history_source','product_history_listing','product_history_listing_source','product_history_observation','product_history_observation_source']){
      const r=(await this.db.query("SELECT has_table_privilege(current_user,$1,'SELECT') AND has_table_privilege(current_user,$1,'INSERT') allowed",[`public.${table}`])).rows[0];
      if(!r?.allowed)throw Error("HISTORY.DATABASE_PERMISSION_REQUIRED");
    }
  }
  // Original capture / collection stays durable if the derived history write is
  // pending. Never turn a successful label into Review because of this projection.
  async attempt(kind:"channel"|"gnc"|"collected",raw:unknown,s:AbortSignal){
    try{return kind==="collected"?await this.collected(String(raw)):await this[kind](raw,s);}
    catch(error){const source=asRow(raw),owner=asRow(source.owner);this.report({event:"HISTORY_PROJECTION_PENDING",kind,
      observationId:text(owner.observationId),operationId:kind==="collected"?String(raw):text(source.operationId)??text(asRow(source.capture).operationId),
      evidenceKey:text(asRow(source.source).objectKey),code:error instanceof Error&&/^HISTORY\.[A-Z_]+$/.test(error.message)?error.message:"HISTORY.STORAGE_OR_EVIDENCE_UNAVAILABLE"});return{status:"pending"};}
  }
  private async read(ref:Pick<ArtifactRef,"objectKey"|"sha256"|"byteSize">,s:AbortSignal){
    if(!Number.isSafeInteger(ref.byteSize)||ref.byteSize<1||ref.byteSize>8*1024*1024)throw Error("HISTORY.EVIDENCE_SIZE");
    const bytes=await this.remote.read(ref.objectKey,ref.byteSize,s);if(!bytes)throw Error("HISTORY.EVIDENCE_MISSING");
    if(bytes.length!==ref.byteSize||sha256(bytes)!==ref.sha256)throw Error("HISTORY.EVIDENCE_CONFLICT");return bytes;
  }
  private async append(raw:unknown){const value=convertHistoryInput(raw),db=await this.db.connect();try{const result=await new ProductHistory(db).append(value);await new ProductHistory(db).verify([value]);return result;}finally{db.release();}}
  private async retain(raw:CaptureHistory,s:AbortSignal){
    const value=CaptureHistorySchema.parse(raw),bytes=Buffer.from(JSON.stringify(value)),key=`v3/history-observations/${hash([value.dataset,value.observationId])}/capture.json`;
    // This receipt permits retry without re-opening the site or re-running labels.
    await this.remote.create(key,bytes,"application/json",s);
    const saved=await this.remote.read(key,bytes.length,s);
    if(!saved||!equal(decode(saved),value))throw Error("HISTORY.CAPTURE_RECEIPT_CONFLICT");
    const result=await this.append(value);this.report({event:"HISTORY_CAPTURE_SAVED",observationId:value.observationId,evidenceKey:key,...result});return value;
  }
  /** Receipt replay never captures again and is safe after a lost database acknowledgement. */
  async replay(key:string,s:AbortSignal){
    if(!/^v3\/history-observations\/[a-f0-9]{64}\/capture.json$/.test(key))throw Error("HISTORY.RECEIPT_KEY");
    const bytes=await this.remote.read(key,8*1024*1024,s);if(!bytes)throw Error("HISTORY.EVIDENCE_MISSING");
    const raw=CaptureHistorySchema.parse(decode(bytes));
    if(key!==`v3/history-observations/${hash([raw.dataset,raw.observationId])}/capture.json`)throw Error("HISTORY.RECEIPT_IDENTITY");
    for(const ref of raw.evidence){const b=await this.remote.read(ref.objectKey,8*1024*1024,s);if(!b||sha256(b)!==ref.sha256)throw Error("HISTORY.EVIDENCE_CONFLICT");}
    return this.append(raw);
  }
  async channel(input:unknown,s:AbortSignal){
    const i=ChannelPlanInputSchema.parse(input),bytes=await this.read(i.source,s),r=asRow(decode(bytes));
    const parsed=(i.channel==="amazon"?parseAmazonRenderedProduct:i.channel==="swanson"?parseSwansonRenderedProduct:parseDtcRenderedProduct)(r,i.expectedUrl,i.owner);
    let capturedAt=timestamp(r.capturedAt),externalId:string|null=null,metrics=commerceMetrics(r.commerce);
    const refs=[{objectKey:i.source.objectKey,sha256:i.source.sha256}];
    if(i.channel==="amazon")externalId=i.owner.listingId;
    if(i.channel==="swanson"){
      const sku=text(asRow(r.commerce).sku);
      externalId=sku&&/^[A-Z][A-Z0-9-]{2,30}$/.test(sku)?sku:`shopify-variant:${i.owner.variantId}`;
      metrics.extras={...metrics.extras,selectedProductId:i.owner.listingId,selectedVariantId:i.owner.variantId,skuVerified:externalId===sku};
    }
    if(i.channel==="dtc"){
      const legacy=asRow(r.legacy),fields=asRow(legacy.fields),variants=Array.isArray(legacy.variants)?legacy.variants.map(asRow):[];
      const selected=asRow(legacy.selectedVariant),only=variants.length===1?variants[0]!:null;
      const variant=Object.keys(selected).length?selected:only;
      const variantId=text(variant?.variantId);
      if(variantId)externalId=`${new URL(i.expectedUrl).hostname.replace(/^www\./,"")}:shopify_variant:${variantId}`;
      metrics=commerceMetrics({...fields,...variant,availability:variant?.available??fields.inStock});
      // A family-level price is not a selected-SKU point. Keep all offers raw.
      if(variants.length>1&&!variant){metrics.price=null;metrics.listPrice=null;metrics.inStock=null;}
      metrics.extras={fields,variants,selectedVariant:variant,priceScope:variant?"selected-variant":variants.length>1?"unresolved-family":"page",purchaseConditions:"see-original-capture"};
      const manifestKey=text(legacy.manifestKey);
      if(manifestKey){
        const expected=`v3/dtc-legacy/${i.source.producer.operationId}/manifest.json`;
        if(manifestKey!==expected)throw Error("HISTORY.DTC_MANIFEST_IDENTITY");
        const mb=await this.remote.read(manifestKey,4*1024*1024,s);if(!mb)throw Error("HISTORY.EVIDENCE_MISSING");
        const manifest=z.object({url:z.string(),files:z.array(z.object({path:z.string(),objectKey:z.string(),sha256:z.string(),byteSize:z.number()}))}).parse(decode(mb));
        if(manifest.url!==i.expectedUrl)throw Error("HISTORY.DTC_MANIFEST_IDENTITY");refs.push({objectKey:manifestKey,sha256:sha256(mb)});
        const f=manifest.files.find(f=>f.path==="harvest-result.json");
        if(f){
          if(!f.objectKey.startsWith(`v3/dtc-legacy/${i.source.producer.operationId}/files/`))throw Error("HISTORY.EVIDENCE_KEY");
          const hb=await this.read(f,s),h=asRow(decode(hb)),counts=asRow(h.counts);
          if(counts.discovered===1&&typeof h.startedAtMs==="number"&&typeof h.finishedAtMs==="number"&&h.finishedAtMs>=h.startedAtMs&&h.finishedAtMs-h.startedAtMs<86400000){
            capturedAt=new Date(h.finishedAtMs).toISOString();metrics.extras={...metrics.extras,capturedAtBasis:"single-product-harvest-finished",captureStartedAt:new Date(h.startedAtMs).toISOString()};
          }
          refs.push({objectKey:f.objectKey,sha256:f.sha256});
        }
      }
    }
    return this.retain({codec:"v3-capture-history/1",dataset:`v3:${i.channel}`,observationId:i.owner.observationId,owner:i.owner,capturedAt,
      listing:{channel:i.channel,url:parsed.url,externalId},metrics,evidence:refs,capture:{input:i,projection:r}},s);
  }
  async gnc(raw:unknown,s:AbortSignal){
    const input=GncAcquireInputSchema.parse(raw);if(input.capture.kind!=="product")return;
    const key=`v3/gnc/${input.capture.operationId}/received.json`,bytes=await this.remote.read(key,65536,s);if(!bytes)throw Error("HISTORY.EVIDENCE_MISSING");
    const receipt=GncReceivedRecordSchema.parse(decode(bytes));if(!equal(receipt.input,input)||input.owner.listingId!==input.capture.sku||receipt.source.objectKey!==`v3/gnc/${input.capture.operationId}/source.html`)throw Error("HISTORY.GNC_IDENTITY");
    assertArtifactBelongsTo(receipt.source,input.owner);
    const html=Buffer.from(await this.read(receipt.source,s)).toString("utf8"),products:Row[]=[];let nodes=0;
    const visit=(value:unknown,depth=0)=>{if(++nodes>2000||depth>20)throw Error("HISTORY.JSON_LIMIT");if(Array.isArray(value)){for(const v of value)visit(v,depth+1);return;}const r=asRow(value),types=Array.isArray(r['@type'])?r['@type']:[r['@type']];if(types.includes("Product")&&String(r.sku)===input.owner.listingId)products.push(r);for(const key of ['@graph','hasVariant'])if(r[key])visit(r[key],depth+1);};
    for(const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){try{visit(JSON.parse(match[1]!));}catch{/* original remains in evidence */}}
    const p=products.length===1?products[0]!:{};
    const offers=Array.isArray(p.offers)?p.offers: p.offers?[p.offers]:[];let offer=offers.length===1?asRow(offers[0]):{};
    if(text(offer.url)){try{const url=new URL(String(offer.url));if(url.protocol!=="https:"||!['www.gnc.com','gnc.com'].includes(url.hostname)||!url.pathname.endsWith(`/${input.capture.sku}.html`))offer={};}catch{offer={};}}
    const metrics=commerceMetrics({price:offer.price,currency:offer.priceCurrency,rating:asRow(p.aggregateRating).ratingValue,reviewCount:asRow(p.aggregateRating).reviewCount,availability:offer.availability});
    metrics.extras={matchedProducts:products,priceScope:offers.length===1?"selected-sku":"unresolved-offers",capturedAtBasis:"capture-received"};
    return this.retain({codec:"v3-capture-history/1",dataset:"v3:gnc",observationId:input.owner.observationId,owner:input.owner,capturedAt:receipt.receivedAt,
      listing:{channel:"gnc",url:input.capture.url,externalId:input.capture.sku},metrics,evidence:[{objectKey:key,sha256:sha256(bytes)},{objectKey:receipt.source.objectKey,sha256:receipt.source.sha256}],capture:{input,receipt}},s);
  }
  async collected(id:string){
    const row=(await this.db.query("SELECT record,record_hash FROM collected_product WHERE operation_id=$1",[id])).rows[0];
    if(!row)return{status:"not-collected"};
    const collection=LabelCollectedProductSchema.parse(row.record);
    if(collection.operationId!==id||labelCollectedHash(collection)!==row.record_hash)throw Error("HISTORY.COLLECTION_INTEGRITY");
    const candidates=(await this.db.query("SELECT source_record_id,record FROM product_history_source WHERE source_key=$1 AND dataset LIKE 'v3:%' AND record->>'codec'='v3-capture-history/1'",[collection.observation.observationId])).rows;
    if(candidates.length!==1){this.report({event:"HISTORY_PROJECTION_PENDING",kind:"collected",operationId:id,observationId:collection.observation.observationId,code:"HISTORY.CAPTURE_ASSOCIATION_PENDING"});return{status:"capture-pending"};}
    const captured=CaptureHistorySchema.parse(candidates[0].record);if(!equal(captured.owner,collection.observation))throw Error("HISTORY.OWNER_CONFLICT");
    const result=await this.append({codec:"v3-formula-history/1",dataset:captured.dataset,observationId:captured.observationId,operationId:id,
      captureSourceId:candidates[0].source_record_id,capturedAt:captured.capturedAt,listing:captured.listing,collection});
    this.report({event:"HISTORY_FORMULA_SAVED",observationId:captured.observationId,operationId:id,...result});return{status:"saved",...result};
  }
}

/** Existing roles opt in on Mini; the Windows browser roles never construct this. */
export function historyObservations(db:pg.Pool,remote:ObjectStore){
  if(process.env.V3_HISTORY_ENABLED!=="true")return undefined;
  if(process.platform!=="darwin")throw Error("HISTORY.MINI_REQUIRED");
  return new HistoryObservations(db,remote);
}
