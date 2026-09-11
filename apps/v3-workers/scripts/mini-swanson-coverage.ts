import assert from "node:assert/strict";
import {hostname} from "node:os";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {isDeepStrictEqual as equal} from "node:util";
import pg from "pg";
import {observationIdentity,SwansonProductJobSchema} from "@crawl-automation/v3-contracts";
import {createR2Objects,RetainedPublication,ArtifactResolver,FileCopies,sha256} from "@crawl-automation/v3-artifacts";
import {EgoTaskPages,EgoFileTransport,AcquireFileModule,FileEvidence,systemDns,type SourceAccess} from "@crawl-automation/v3-acquisition";
import {SwansonCatalogSource,SwansonEgoReader,SwansonLiveProduct,ChannelProductPlans} from "@crawl-automation/v3-channels";
import {SwansonFamilies} from "../../../packages/v3-channels/src/swanson-family.js";
import {SwansonProductJobs} from "../../../packages/v3-product/src/swanson-product-jobs.js";
import {PostgresResourceAdmission} from "../../../packages/v3-product/src/resource-admission.js";
import {TextLocalStore} from "@crawl-automation/v3-text";
import {PostgresReviews} from "@crawl-automation/v3-review";
import {readGncPrivateJson} from "../src/gnc-config.js";

// Finite live source proof: exactly two catalog pages and the observed two-size K2 family.
// Does not submit the 45-family brand to production or write collected products.
async function main(){
 assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);assert.equal(process.argv[2],"--bounded-browser-proof");
 const root="/Users/barry/apps/crawlv3-batch-a.UiA4dx",base=await readGncPrivateJson(root+"/live/channel-resident-20260910-v2/swanson.private.json") as any;
 assert.equal(base.r2.bucket,"supply-smart-test");assert.equal(new URL(base.database.connectionString).pathname,"/crawler_v3_test");
 const id="swanson-coverage-"+randomUUID(),dir=root+"/live/"+id;await mkdir(dir,{mode:0o700});
 const report:any={id,dir,status:"running",products:[],pages:[],browserPermitReleased:false,ocrCalls:0,modelCalls:0,productWrites:0};
 const save=()=>writeFile(join(dir,"report.json"),JSON.stringify(report,null,2),{mode:0o600});await save();console.log(JSON.stringify({event:"COVERAGE_BROWSER_STARTED",dir}));
 const r2=createR2Objects({...base.r2,prefix:base.r2.prefix+"/"+id},base.r2Credentials),db=new pg.Pool({connectionString:base.database.connectionString,max:3});
 const local=await TextLocalStore.open(join(dir,"journal")),copies=await FileCopies.open(join(dir,"cache")),publication=new RetainedPublication(local,r2.store),reviews=new PostgresReviews(db);
 const pages=new EgoTaskPages(base.browser,local),admission=new PostgresResourceAdmission(db),plans=new ChannelProductPlans(publication,new ArtifactResolver(copies,r2.store),reviews),files=new FileEvidence({local,remote:r2.store,copies,reviews});
 let permit:any=null,held=false;
 const browser=async<T>(name:string,fn:()=>Promise<T>)=>{
  permit={permitId:`permit-${id}-${name}`,workflowId:`manual-${id}-${name}`,runId:randomUUID(),needs:[{resourceId:base.browserResource,units:1}]};
  assert.equal((await admission.reserve(permit)).status,"granted");held=true;await save();
  const result=await fn();await admission.release(permit);held=false;return result;
 };
 try{
  const scope={brandId:"healthy-origins-proof",sourceId:"swanson-healthy-origins-proof",channel:"swanson" as const,region:"US",rootUrl:"https://www.swansonvitamins.com/collections/brand-healthy-origins",scopeVersion:"visible-storefront-1"};
  const catalog=new SwansonCatalogSource(publication,"Healthy Origins",{capture:async(input,signal,retain)=>pages.using(`catalog-${input.page}-${id}`,signal,async page=>{
    const {projection}=await new SwansonEgoReader(page).catalog(input.cursor??scope.rootUrl,"Healthy Origins",signal);await retain(projection);return projection;
  })});
  let cursor:string|null=null;
  for(let page=0;page<2;page++){
   const result=await browser(`catalog-${page}`,()=>catalog.read({catalogId:id,scope,page,cursor},AbortSignal.timeout(90000)));
   await catalog.verify(result,AbortSignal.timeout(30000));report.pages.push(result);cursor=result.nextCursor;await save();
   console.log(JSON.stringify({event:"CATALOG_PAGE_CLOSED",page,entries:result.entries.length,next:cursor}));if(!cursor)break;
  }
  assert.equal(report.pages.length,2);assert.equal(cursor,null);
  const all=new Map<string,any>();for(const p of report.pages)for(const e of p.entries){const old=all.get(e.listingId);if(old)assert.deepEqual(old,e);all.set(e.listingId,e);}
  assert.equal(all.size,45);report.visibleFamilyCount=all.size;report.catalogCoverage="families-observed; variants-not-exhausted";
  const handle="healthy-origins-vitamin-k2-mk-7-100-mcg-180-veg-sgels",entry=all.get(handle);assert.ok(entry);
  const d={catalogId:id,scope,entry,source:report.pages[0].source,discoveryId:`family-${id}`,workflowId:`family-${id}`};
  const policy={scope,queues:base.productQueues,resources:base.productResources};
  // This finite source proof uses an explicit in-memory discovery ledger. The real
  // Postgres/Temporal publication, restart and dispatch cases are separate integration checks.
  const jobs=new SwansonProductJobs({query:async(_sql,args)=>({rows:args?.[0]===d.discoveryId?[{record:d}]:[],rowCount:args?.[0]===d.discoveryId?1:0})},publication,policy),job=await jobs.prepare(d,d.workflowId,AbortSignal.timeout(30000));
  const families=new SwansonFamilies(publication,{capture:async(j,signal,retain)=>pages.using(`${j.sessionId}-family`,signal,async page=>{const p=await new SwansonEgoReader(page).product(j.discovery.entry.url,signal);await retain(p);return p;})});
  const family=await browser("family",()=>families.capture(job,AbortSignal.timeout(90000)));assert.equal(family.coverage,"declared-options");assert.equal(family.discoveries.length,2);report.family=family;await save();
  for(const discovery of family.discoveries){
   const {job:member}=await jobs.prepareVariant({family:d,discovery},AbortSignal.timeout(30000));SwansonProductJobSchema.parse(member);
   const result=await browser(`sku-${discovery.entry.variantId}`,()=>pages.using(member.sessionId,AbortSignal.timeout(240000),async page=>{
    const product=new SwansonLiveProduct(publication,{text:base.sourceText,ocr:base.ocr,visionConfigFingerprint:base.sourceVisionConfigFingerprint,egressId:base.egressId},{capture:async(j,s)=>new SwansonEgoReader(page).product(j.discovery.entry.url,s)});
    const captured=await product.capture(member,AbortSignal.timeout(60000)),input=captured.sourcePlan,prepared=await plans.run(input,AbortSignal.timeout(30000));
    assert.equal(prepared.status,"prepared");const plan=await plans.inspect(input,AbortSignal.timeout(30000));assert.ok(plan);const receipts=[];
    for(const source of plan.manifest.sources)if(source.kind==="file-image"){
     const request=source.plan.acquire,url=await plans.fileSource(input,request,AbortSignal.timeout(30000));
     const access:SourceAccess={acquire:async actual=>{assert.ok(equal(actual,request));let released=false;return {owner:observationIdentity(request),sourceId:request.sourceId,resourceId:request.resourceId,binding:request.binding,url,allowedOrigins:["https://www.swansonvitamins.com"],transport:new EgoFileTransport({browser:page,pageUrl:input.expectedUrl,allowedUrls:[url]},input.binding.egressId),headersFor:()=>({}),assertActive:()=>{if(released)throw Error("SOURCE.SESSION_UNAVAILABLE");},release:async()=>{released=true;}};}};
     const acquired=await new AcquireFileModule(files,{access,dns:systemDns}).run(request,AbortSignal.timeout(60000));assert.equal(acquired.status,"durable");receipts.push(acquired);
    }
    return {job:member,plan:input,files:receipts};
   }));
   report.products.push({...result,browserPageClosed:true});await save();console.log(JSON.stringify({event:"VARIANT_FILES_CLOSED",variantId:discovery.entry.variantId,files:result.files.length}));
  }
  assert.equal(new Set(report.products.map((p:any)=>p.plan.owner.listingId)).size,2);
  const cold=new SwansonFamilies(new RetainedPublication(await TextLocalStore.open(join(dir,"cold")),r2.store));assert.deepEqual(await cold.inspect(job,AbortSignal.timeout(30000)),family);
  for(const p of report.products)for(const f of p.files){const b=await r2.store.read(f.file.objectKey,20*1024*1024,AbortSignal.timeout(30000));assert.ok(b);assert.equal(sha256(b),f.file.sha256);}
  report.coldReadback=true;report.browserPermitReleased=true;report.status="passed";
 }catch(e){report.status="failed";report.error=e instanceof Error?e.message:"UNKNOWN";process.exitCode=1;}
 finally{report.held=held;report.permit=permit;await save();r2.close();await db.end();console.log(JSON.stringify({event:"COVERAGE_BROWSER_FINISHED",dir,status:report.status,held,error:report.error}));}
}
main().catch(()=>{console.error("COVERAGE_PROOF_REJECTED");process.exitCode=1;});
