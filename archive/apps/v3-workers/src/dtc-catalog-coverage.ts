import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DtcCatalogCoverageSchema,type DtcSitePolicy } from '@crawl-automation/v3-contracts';
import type { CdpOwnedPage,CdpTaskPort } from '@crawl-automation/v3-acquisition';
import { dtcCatalogCoverageTarget,verifyDtcCatalogCoverage } from '../../../packages/v3-channels/src/dtc-catalog-coverage.js';

/** Host-owned bounded probe, on the existing task target and before page cleanup. */
export async function captureDtcCatalogCoverage(out:string,url:string,site:DtcSitePolicy,page:CdpOwnedPage,port:CdpTaskPort,signal:AbortSignal){
 const target=dtcCatalogCoverageTarget(url);
 if(!target||site.selectedUrls!==null||site.catalogPages.length!==1||site.catalogPages[0]!==url)return undefined;
 const evaluate=async(expression:string)=>{
  await port.guard(signal);
  const result=await port.call(page.targetId,'Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},signal);
  if(result?.exceptionDetails||!result?.result?.value)throw Error('DTC.CATALOG_END_UNVERIFIED');return result.result.value;
 };
 const dom=await evaluate(`(()=>{const root=document.querySelector(${JSON.stringify(site.catalogRoot)});if(!root)throw Error('catalog_root_missing');return {url:location.href,links:[...root.querySelectorAll('a[href]')].map(a=>a.href).slice(0,1001)};})()`);
 if(dom.url!==url)throw Error('DTC.CATALOG_END_UNVERIFIED');
 const responses=[];
 for(let index=1;index<=2;index++){
  const endpoint=`${target.endpoint}?limit=100&page=${index}`;
  const response=await evaluate(`(async()=>{const c=new AbortController(),timer=setTimeout(()=>c.abort(),10000);try{const r=await fetch(${JSON.stringify(endpoint)},{credentials:'include',signal:c.signal,headers:{accept:'application/json'}});const body=await r.text();if(body.length>524288)throw Error('catalog_response_limit');return {url:r.url,status:r.status,contentType:r.headers.get('content-type')||'',body};}finally{clearTimeout(timer);}})()`);
  responses.push(response);
  if(response.status!==200)throw Error('DTC.CATALOG_END_UNVERIFIED');
  const data=JSON.parse(response.body);if(Array.isArray(data.products)&&data.products.length===0)break;
 }
 const proof=DtcCatalogCoverageSchema.parse({version:target.version,catalogUrl:url,dom,responses});
 const data=JSON.parse(await readFile(join(out,'catalog.json'),'utf8'));
 verifyDtcCatalogCoverage(proof,url,data.entries);
 return proof;
}
