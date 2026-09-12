import { DtcCatalogCoverageSchema } from '@crawl-automation/v3-contracts';

/** The API is an end oracle only; every discovered URL still needs DOM evidence. */
export function verifyDtcCatalogCoverage(raw:unknown,url:string,entries:{url:string}[]):boolean{
 const proof=DtcCatalogCoverageSchema.parse(raw),root=new URL(url);
 if(root.pathname!=='/collections/all'||root.search||root.hash||proof.catalogUrl!==url||proof.dom.url!==url)throw Error('DTC.CATALOG_END_UNVERIFIED');
 const canonical=(raw:string)=>{const u=new URL(raw);if(u.origin!==root.origin)return null;const match=/^(?:\/collections\/[^/]+)?\/products\/([^/]+)\/?$/.exec(u.pathname);return match?`${root.origin}/products/${match[1]}`:null;};
 const observed=[...new Set(proof.dom.links.map(canonical).filter((u):u is string=>u!==null))].sort();
 const discovered=entries.map(e=>canonical(e.url));
 if(discovered.some(u=>u===null)||new Set(discovered).size!==discovered.length)throw Error('DTC.CATALOG_END_UNVERIFIED');
 const products:string[]=[];let terminal=false;
 for(const [index,response] of proof.responses.entries()){
  if(terminal||response.url!==`${root.origin}/products.json?limit=100&page=${index+1}`||!/json/i.test(response.contentType))throw Error('DTC.CATALOG_END_UNVERIFIED');
  const data=JSON.parse(response.body);
  if(!Array.isArray(data.products)||data.products.length>100)throw Error('DTC.CATALOG_END_UNVERIFIED');
  if(!data.products.length){terminal=true;continue;}
  for(const p of data.products){
   if(typeof p.handle!=='string'||!p.handle||/[/\\?#\s]/.test(p.handle)||!Number.isSafeInteger(p.id)||p.id<=0)throw Error('DTC.CATALOG_END_UNVERIFIED');
   products.push(`${root.origin}/products/${p.handle}`);
  }
 }
 const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
 if(!terminal||products.length>100||new Set(products).size!==products.length||!same(products.sort(),observed)||!same([...discovered].sort(),observed))throw Error('DTC.CATALOG_END_UNVERIFIED');
 return true;
}
