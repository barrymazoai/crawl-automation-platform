import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import { sha256, type RetainedPublication } from '@crawl-automation/v3-artifacts';
import { DtcScopeSkipSchema, DtcRenderedProductSchema, DtcRenderedCatalogSchema, type DtcSitePolicy } from '@crawl-automation/v3-contracts';
import { type FileTransport, type Address, type Response } from '@crawl-automation/v3-acquisition';

const json=(v:unknown)=>Buffer.from(JSON.stringify(v));
const address=(url:string)=>'dtc-'+sha256(Buffer.from(url));
const image=z.object({url:z.string().url(),localPath:z.string().min(1),mime:z.string().optional()});
const record=z.object({productUrl:z.string().url(),fields:z.record(z.string(),z.unknown()),gallery:z.array(image).min(1).max(100),variants:z.array(z.record(z.string(),z.unknown())).optional(),pageHtml:z.unknown().optional(),flags:z.array(z.string()).optional()}).passthrough();
const file=z.strictObject({path:z.string(),objectKey:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/),byteSize:z.number().int().positive(),mediaType:z.string()});
const manifestSchema=z.strictObject({version:z.literal('dtc-legacy/1'),url:z.string().url(),files:z.array(file).max(1000),images:z.array(file.extend({url:z.string().url()})).max(100)});
const normal=(p:string)=>p.replaceAll('\\','/');
const safe=(p:string)=>{const n=normal(p);if(isAbsolute(p)||/^[A-Za-z]:/.test(n)||n.split('/').some(x=>!x||x==='.'||x==='..'))throw Error('DTC.EVIDENCE_PATH');return n;};
const mime=(p:string)=>/\.png$/i.test(p)?'image/png':/\.webp$/i.test(p)?'image/webp':/\.jpe?g$/i.test(p)?'image/jpeg':/\.html?$/i.test(p)?'text/html':/\.json$/i.test(p)?'application/json':'application/octet-stream';
/** Publish the entire legacy capture directory, not only fields understood by V3. */
export async function retainLegacyDirectory(root:string,key:string,publication:RetainedPublication,s:AbortSignal){
 if((await lstat(root)).isSymbolicLink())throw Error('DTC.EVIDENCE_PATH');
 const files:z.infer<typeof file>[]=[];let total=0;
 async function walk(dir:string){for(const name of (await readdir(dir)).sort()){
   const absolute=join(dir,name),stat=await lstat(absolute);if(stat.isSymbolicLink())throw Error('DTC.EVIDENCE_PATH');
   if(stat.isDirectory()){await walk(absolute);continue;}if(!stat.isFile())throw Error('DTC.EVIDENCE_PATH');
   if(files.length>=1000||stat.size>32*1024*1024||(total+=stat.size)>256*1024*1024)throw Error('ARTIFACT.TOO_LARGE');
   const path=safe(normal(relative(resolve(root),resolve(absolute)))),bytes=await readFile(absolute);if(bytes.length===0)continue;
   const entry={path,objectKey:`${key}/files/${sha256(Buffer.from(path))}`,sha256:sha256(bytes),byteSize:bytes.length,mediaType:mime(path)};
   await publication.publish(entry.objectKey,bytes,entry.mediaType,s);files.push(entry);
 }}
 await walk(root);return files;
}
export async function legacyProductProjection(root:string,key:string,url:string,site:DtcSitePolicy,publication:RetainedPublication,s:AbortSignal){
 const files=await retainLegacyDirectory(root,key,publication,s);
 const raw=JSON.parse(await readFile(join(root,'evidence','records.json'),'utf8'));
 const records=z.array(record).parse(raw);
 const expected=new URL(url),matches=records.filter(r=>{const u=new URL(r.productUrl);return u.origin===expected.origin&&u.pathname===expected.pathname;});
 if(records.length!==1||matches.length!==1)throw Error('DTC.IDENTITY_UNVERIFIED');
 const r=matches[0]!;if(r.flags?.some(f=>/image_download_failed|page_html_failed/.test(f)))throw Error('DTC.EVIDENCE_INCOMPLETE');
 const selected=expected.searchParams.get('variant'),variant=selected?r.variants?.find(v=>String(v.variantId)===selected):null;
 if(selected&&!variant)throw Error('DTC.VARIANT_UNVERIFIED');
 const images=r.gallery.map(g=>{if(!site.imageOrigins.includes(new URL(g.url).origin))throw Error('DTC.IMAGE_ORIGIN');const f=files.find(f=>f.path===safe(g.localPath));if(!f)throw Error('DTC.EVIDENCE_INCOMPLETE');return {...f,url:g.url,mediaType:g.mime||f.mediaType};});
 if(new Set(images.map(i=>i.url)).size!==images.length)throw Error('DTC.EVIDENCE_AMBIGUOUS');
 const htmlPath=typeof r.pageHtml==='string'?r.pageHtml:typeof r.pageHtml==='object'&&r.pageHtml!==null&&'localPath' in r.pageHtml?String(r.pageHtml.localPath):null;
 if(!htmlPath||!files.some(f=>f.path===safe(htmlPath)))throw Error('DTC.HTML_MISSING');
 const html=await readFile(join(root,safe(htmlPath)),'utf8');
 const manifest=manifestSchema.parse({version:'dtc-legacy/1',url,files,images});
 await publication.publish(`${key}/manifest.json`,json(manifest),'application/json',s);
 const sections=Object.entries(r.fields).filter(([k,v])=>typeof v==='string'&&!['title','sku','price','currency'].includes(k)).map(([,v])=>String(v)).flatMap(v=>v.match(/[\s\S]{1,6000}/g)??[]).slice(0,20);
 return DtcRenderedProductSchema.parse({codec:'dtc-rendered/1',url,listingId:address(url),brandName:site.brandName,title:r.fields.title,sections,images:images.map(i=>i.url),selectedOnly:true,snapshotKeys:[`${key}/manifest.json`],legacy:{manifestKey:`${key}/manifest.json`,detailsHtml:html,fields:r.fields,variants:r.variants??[],selectedVariant:variant??null}});
}
export async function legacyCatalogProjection(root:string,key:string,url:string,site:DtcSitePolicy,publication:RetainedPublication,s:AbortSignal,coverage?:unknown){
 const files=await retainLegacyDirectory(root,key,publication,s),raw=JSON.parse(await readFile(join(root,'catalog.json'),'utf8'));
 const data=z.object({entries:z.array(z.object({url:z.string().url(),title:z.string().nullable()})).max(100),navigation:z.array(z.string().url()).max(100)}).parse(raw);
 for(const e of data.entries){const u=new URL(e.url);if(u.origin!==site.origin||!u.pathname.startsWith(site.productPathPrefix))throw Error('DTC.IDENTITY_UNVERIFIED');}
 if(!files.some(f=>f.mediaType==='text/html')||!files.some(f=>f.mediaType==='image/png'))throw Error('DTC.EVIDENCE_INCOMPLETE');
 await publication.publish(`${key}/catalog-manifest.json`,json({version:'dtc-legacy/1',url,files}),'application/json',s);
 return DtcRenderedCatalogSchema.parse({codec:'dtc-catalog-rendered/1',url,brandName:site.brandName,entries:data.entries.map(e=>({...e,listingId:address(e.url),variantId:null})),navigation:data.navigation,snapshotKeys:[`${key}/catalog-manifest.json`],...(coverage?{coverage}:{})});
}
/** File Activities consume the exact retained original. No Chrome or website request. */
export class DtcLegacyFileTransport implements FileTransport{
 readonly targetResolution='browser' as const;
 constructor(readonly publication:RetainedPublication,readonly operationId:string,readonly pageUrl:string,readonly allowedUrl:string,readonly egressId:string){}
 async get(url:URL,address:Address|undefined,headers:Readonly<Record<string,string>>,s:AbortSignal):Promise<Response>{
  if(address!==undefined||Object.keys(headers).length||url.href!==this.allowedUrl)throw Error('SOURCE.SESSION_MISMATCH');
  const bytes=await this.publication.remote.read(`v3/dtc-legacy/${this.operationId}/manifest.json`,4*1024*1024,s);if(!bytes)throw Error('DTC.EVIDENCE_MISSING');
  const m=manifestSchema.parse(JSON.parse(Buffer.from(bytes).toString()));if(m.url!==this.pageUrl)throw Error('SOURCE.SESSION_MISMATCH');
  const f=m.images.find(i=>i.url===url.href);if(!f)throw Error('DTC.EVIDENCE_MISSING');
  const body=await this.publication.remote.read(f.objectKey,f.byteSize,s);if(!body||body.length!==f.byteSize||sha256(body)!==f.sha256)throw Error('ARTIFACT.INTEGRITY');let closed=false;
  return {status:200,headers:{'content-type':f.mediaType,'content-length':String(f.byteSize)},body:(async function*(){s.throwIfAborted();if(!closed)yield body;})(),close(){closed=true;}};
 }
}

/** A model's reason string alone is insufficient: require the exact harvest exclusion and empty records. */
export async function legacyScopeSkipIfExcluded(root:string,key:string,operationId:string,url:string,publication:RetainedPublication,s:AbortSignal){
 const bytes=await readFile(join(root,'harvest-result.json'),'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
 if(bytes===null)return null;
 const result=z.object({excluded:z.array(z.object({url:z.string(),reason:z.string()}))}).safeParse(JSON.parse(bytes));
 if(!result.success||!result.data.excluded.some(e=>e.url===url&&e.reason==='bundle_or_pack'))return null;
 // A matching exclusion is only a candidate; mixed/failed output still fails the full proof below.
 return legacyScopeSkip(root,key,operationId,url,publication,s);
}
export async function legacyScopeSkip(root:string,key:string,operationId:string,url:string,publication:RetainedPublication,s:AbortSignal){
 const result=JSON.parse(await readFile(join(root,'harvest-result.json'),'utf8'));
 const records=JSON.parse(await readFile(join(root,'evidence','records.json'),'utf8'));
 if(!Array.isArray(records)||records.length||!Array.isArray(result.excluded)||result.excluded.length!==1||result.excluded[0].url!==url||result.excluded[0].reason!=='bundle_or_pack'||!Array.isArray(result.failed)||result.failed.length)throw Error('DTC.SCOPE_EXCLUSION_UNVERIFIED');
 const files=await retainLegacyDirectory(root,key,publication,s),evidenceKey=`${key}/scope-skip.json`;
 const evidence=json({version:'dtc-scope-skip/1',operationId,url,reason:'bundle_or_pack',policy:'nutrition-single-product/1',files});
 await publication.publish(evidenceKey,evidence,'application/json',s);
 return DtcScopeSkipSchema.parse({status:'skipped',operationId,url,reason:'bundle_or_pack',policy:'nutrition-single-product/1',evidenceKey,evidenceSha256:sha256(evidence)});
}
