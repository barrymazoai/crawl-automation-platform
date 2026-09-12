import{isDeepStrictEqual as equal}from'node:util';import{CatalogPageInputSchema,CatalogPageSchema,ArtifactRefSchema,DtcRenderedCatalogSchema,type CatalogPageInput,type CatalogPage}from'@crawl-automation/v3-contracts';import{RetainedPublication,sha256,verifyBytes}from'@crawl-automation/v3-artifacts';import{dtcAddress,parseDtcRenderedCatalog}from'./dtc-rendered.js';
import {verifyDtcCatalogCoverage} from './dtc-catalog-coverage.js';
const bytes=(v:unknown)=>Buffer.from(JSON.stringify(v));const limit=2*1024*1024;
// A configured selected URL may name a verified variant of an observed canonical
// product link. Never replace an observed variant, cross products, or drop query
// parameters from the selected identity. The persisted policy records the choice.
function selectedEntries(entries:{listingId:string;variantId:string|null;url:string}[],selected:string[]|null){
 const urls=entries.flatMap(e=>{
  if(!selected)return[e.url];
  const observed=new URL(e.url);
  return selected.filter(raw=>{const chosen=new URL(dtcAddress(raw).url);return chosen.href===observed.href||(!observed.search&&chosen.origin===observed.origin&&chosen.pathname===observed.pathname);});
 });
 return [...new Set(urls.map(url=>dtcAddress(url).url))].map(url=>({...dtcAddress(url),variantId:null,kind:'product' as const}));
}
export interface DtcCatalogPort{capture(input:CatalogPageInput,signal:AbortSignal,retain:(p:unknown)=>Promise<void>):Promise<unknown>}
/** Explicit page set is a bounded scope, not proof of all store navigation or hidden variants. */
export class DtcCatalogSource{
 constructor(readonly publication:RetainedPublication,readonly policy:{brandName:string;pages:string[];selectedUrls:string[]|null},readonly browser?:DtcCatalogPort){if(!policy.pages.length||policy.pages.length>10||new Set(policy.pages.map(p=>dtcAddress(p).url)).size!==policy.pages.length||policy.selectedUrls&&(!policy.selectedUrls.length||policy.selectedUrls.some(a=>!a.startsWith('https://'))))throw Error('DTC.CATALOG_POLICY_INVALID');}
 private key(i:CatalogPageInput){return 'v3/dtc-catalog/'+sha256(bytes(i));}
 private input(raw:unknown){const i=CatalogPageInputSchema.parse(raw);if(i.scope.channel!=='dtc'||i.page>=this.policy.pages.length||dtcAddress(i.scope.rootUrl).url!==dtcAddress(this.policy.pages[0]!).url||(i.page===0?i.cursor!==null:i.cursor!==this.policy.pages[i.page]))throw Error('DTC.CATALOG_SCOPE_CONFLICT');return i;}
 private derive(i:CatalogPageInput,raw:unknown):CatalogPage{const p=DtcRenderedCatalogSchema.parse(raw),parsed=parseDtcRenderedCatalog(p,this.policy.pages[i.page]!,this.policy.brandName),b=bytes(p),id=sha256(bytes(i)),next=this.policy.pages[i.page+1]??null;
 if(next&&!p.navigation.some(n=>dtcAddress(n).url===dtcAddress(next).url))throw Error('DTC.CATALOG_NAVIGATION_UNVERIFIED');
 const source=ArtifactRefSchema.parse({schemaVersion:1,artifactId:'catalog-'+id,observationId:'catalog-'+id,sourceId:i.scope.sourceId,listingId:'catalog',variantId:null,kind:'result-json',mediaType:'application/json',objectKey:this.key(i)+'/projection.json',byteSize:b.length,sha256:sha256(b),producer:{operationId:'capture-'+id,module:'dtc.catalog',implementationVersion:'dtc-catalog/1'}});
 const complete=p.coverage!==undefined&&!next&&this.policy.pages.length===1&&this.policy.selectedUrls===null&&verifyDtcCatalogCoverage(p.coverage,p.url,p.entries);
 return CatalogPageSchema.parse({codec:'catalog-page/1',input:i,source,entries:selectedEntries(parsed.entries,this.policy.selectedUrls),nextCursor:next,completion:next?'more':complete?'complete':'unknown',endEvidence:complete?source:null});}
 async inspect(raw:unknown,signal:AbortSignal){const i=this.input(raw),key=this.key(i),ready=await this.publication.remote.read(key+'/ready.json',limit,signal);if(!ready)return null;const p=await this.publication.remote.read(key+'/projection.json',limit,signal),intent=await this.publication.remote.read(key+'/intent.json',limit,signal);if(!p||!intent||!equal(JSON.parse(Buffer.from(intent).toString()),{input:i,policy:this.policy}))throw Error('DTC.CATALOG_EVIDENCE_CONFLICT');const page=this.derive(i,JSON.parse(Buffer.from(p).toString()));if(!equal(JSON.parse(Buffer.from(ready).toString()),page))throw Error('DTC.CATALOG_EVIDENCE_CONFLICT');return page;}
 async read(raw:unknown,signal:AbortSignal){const i=this.input(raw),old=await this.inspect(i,signal);if(old)return old;if(!this.browser)throw Error('DTC.CAPTURE_UNAVAILABLE');const key=this.key(i);if(await this.publication.remote.create(key+'/intent.json',bytes({input:i,policy:this.policy}),'application/json',signal)!=='created')throw Error('DTC.CAPTURE_UNRESOLVED');
 const retain=async(raw:unknown)=>{const p=DtcRenderedCatalogSchema.parse(raw),page=this.derive(i,p);await this.publication.publish(page.source.objectKey,bytes(p),'application/json',signal);};
 const p=await this.browser.capture(i,signal,retain),page=this.derive(i,p);await retain(p);await this.publication.publish(key+'/ready.json',bytes(page),'application/json',signal);await this.verify(page,signal);return page;}
 async verify(raw:CatalogPage,signal:AbortSignal){const page=CatalogPageSchema.parse(raw),i=this.input(page.input),b=await this.publication.remote.read(page.source.objectKey,limit,signal);if(!b)throw Error('DTC.CATALOG_EVIDENCE_MISSING');verifyBytes(page.source,b,limit);if(!equal(this.derive(i,JSON.parse(Buffer.from(b).toString())),page)||!equal(await this.inspect(i,signal),page))throw Error('DTC.CATALOG_CLOSE_UNVERIFIED');}
}
