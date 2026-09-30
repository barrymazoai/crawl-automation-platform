// Offline Brand identity evidence, run on Server 1. For each Review candidate whose
// sample product HTML was already archived by the product queue, read the exact
// archived bytes (local source cache when present, otherwise R2), verify them
// against the immutable receipt, and extract the Amazon byline brand name and
// store link the way packages/v3-channels amazon-brand-entry does. No HTTP to
// Amazon, no paid request, no database write.
//   node brand-byline-from-archive.mjs <work.json> <out.json> [release source dir]
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const [workPath,outPath,source='/Users/server/apps/crawler-v3/releases/fleet-20260924/source']=process.argv.slice(2);
const require=createRequire(source+'/packages/v3-channels/package.json');
const {parseHTML}=require('linkedom');
const {S3Client,GetObjectCommand}=createRequire(source+'/packages/v3-artifacts/package.json')('@aws-sdk/client-s3');
const m=JSON.parse(fs.readFileSync('/Users/server/apps/crawler-v3/live/deployment.json','utf8'));
const cap=JSON.parse(fs.readFileSync(m.jobs.find(j=>j.id==='amazon-capture').env.V3_AMAZON_LIVE_CONFIG,'utf8'));
const r2=new S3Client({endpoint:cap.r2.endpoint,region:'auto',credentials:cap.r2Credentials,maxAttempts:1,forcePathStyle:true,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
const sha=b=>createHash('sha256').update(b).digest('hex');
const get=async key=>{try{const r=await r2.send(new GetObjectCommand({Bucket:cap.r2.bucket,Key:cap.r2.prefix+'/'+key}),{abortSignal:AbortSignal.timeout(30000)});return Buffer.from(await r.Body.transformToByteArray());}catch(e){if(e?.name==='NoSuchKey'||e?.$metadata?.httpStatusCode===404)return null;throw e;}};
const text=e=>(e?.textContent??'').replace(/\s+/g,' ').trim();
function extract(html){
 if(/validateCaptcha|Robot Check|Enter the characters you see below/i.test(html))return {error:'ACCESS_CHALLENGE'};
 const {document:d}=parseHTML(html);for(const e of d.querySelectorAll('script,style'))e.remove();
 const ppd=d.querySelector('#ppd'),asinInputs=[...(ppd?.querySelectorAll('#ASIN')??d.querySelectorAll('#ASIN'))].map(e=>e.getAttribute('value'));
 const bylines=[...(ppd??d).querySelectorAll('#bylineInfo')];
 const byline=bylines[0],raw=text(byline);
 const name=raw.replace(/^Visit the\s+/i,'').replace(/\s+Store$/i,'').replace(/^Brand:\s*/i,'').trim();
 const href=byline?.getAttribute('href')??null;
 let overviewBrand=null;
 for(const row of d.querySelectorAll('#productOverview_feature_div tr, #poExpander tr, #detailBullets_feature_div li, #prodDetails tr')){const t=text(row);const mm=/^Brand(?: Name)?\s*:?\s*(.+)$/i.exec(t.replace(/‎|‏/g,''));if(mm){overviewBrand=mm[1].trim().slice(0,80);break;}}
 return {pageAsins:[...new Set(asinInputs)],bylineCount:bylines.length,bylineRaw:raw||null,bylineName:name||null,storeHref:href,title:text(d.querySelector('#productTitle'))||null,overviewBrand,
  error:!ppd?'NO_PPD':bylines.length!==1?'BYLINE_COUNT_'+bylines.length:!name?'BRAND_NAME_EMPTY':null};
}
const work=JSON.parse(fs.readFileSync(workPath,'utf8'));const out=[];let done=0;
const run=async w=>{const prefix='v3/amazon-products/'+w.operationId;const row={id:w.id,asin:w.asin,code:w.code,inputName:w.name,operationId:w.operationId};
 try{const rawReceipt=await get(prefix+'/original.json');if(!rawReceipt){row.error='RECEIPT_MISSING';return row;}
  const receipt=JSON.parse(rawReceipt.toString('utf8'));row.capturedAt=receipt.capturedAt;row.url=receipt.url;
  let bytes=null;const local=cap.cacheRoot+'/'+receipt.source.sha256+'.blob';
  if(fs.existsSync(local)){bytes=fs.readFileSync(local);row.bytesFrom='local-cache';}
  if(!bytes||sha(bytes)!==receipt.source.sha256){bytes=await get(receipt.source.objectKey);row.bytesFrom='r2';}
  if(!bytes){row.error='HTML_MISSING';return row;}
  if(sha(bytes)!==receipt.source.sha256||bytes.length!==receipt.source.byteSize){row.error='HTML_HASH_MISMATCH';return row;}
  row.sha256=receipt.source.sha256;row.byteSize=bytes.length;Object.assign(row,extract(bytes.toString('utf8')));
  if(!row.error&&!row.pageAsins.includes(w.asin))row.error='PRODUCT_IDENTITY';
 }catch(e){row.error='READ_FAILED:'+(e?.name??'Error');}
 return row;};
const queue=[...work];const workers=Array.from({length:6},async()=>{while(queue.length){const w=queue.shift();out.push(await run(w));done++;if(done%25===0)console.error('progress',done,'/',work.length);}});
await Promise.all(workers);r2.destroy();
fs.writeFileSync(outPath,JSON.stringify(out,null,1));
const errors={};for(const r of out)errors[r.error??'ok']=(errors[r.error??'ok']||0)+1;
console.log(JSON.stringify({at:new Date().toISOString(),work:work.length,outcomes:errors,bytesFrom:out.reduce((a,r)=>(a[r.bytesFrom??'none']=(a[r.bytesFrom??'none']||0)+1,a),{})}));
