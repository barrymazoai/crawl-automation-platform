// Mini-only acceptance. New local evidence, exact resource admission, no old record mutation.
import fs from 'node:fs/promises';
import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
const [work,mode]=process.argv.slice(2),main='/Users/barry/apps/crawlv3-batch-a.UiA4dx';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);assert.ok(work.startsWith('/Users/barry/apps/crawlv3-history-20260913/'));
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),keep=(p,v)=>fs.writeFile(p,JSON.stringify(v,null,2),{flag:'wx',mode:0o600});
const lib=await import(work+'/candidate/acceptance/purchase-conditions-inspect.js'),m=await read(main+'/live/deployment.json');
const db=new pg.Pool({connectionString:m.database.connectionString,max:1,statement_timeout:5000}),gate=new lib.PostgresResourceAdmission(db);
const dir=work+'/acceptance-'+mode;await fs.mkdir(dir,{mode:0o700});
const id='unified-check-'+randomUUID(),permit={permitId:'permit-'+id,workflowId:'manual-'+id,runId:randomUUID(),needs:mode==='browser'?[{resourceId:'mini-ego-space-1',units:1}]:[{resourceId:'mini-model-account',units:1},{resourceId:'mini-cpu',units:1}]};
let held=false,released=false,provider;
try{
 assert.equal((await gate.reserve(permit)).status,'granted');held=true;await keep(dir+'/intent.json',{at:new Date().toISOString(),permit});
 if(mode==='browser'){
  const c=await read(m.jobs.find(j=>j.id==='amazon-capture').env.V3_AMAZON_LIVE_CONFIG),pages=new lib.EgoTaskPages(c.browser,await lib.TextLocalStore.open(dir+'/journal'));
  const results=[];let userControl=false;
  try{
   await pages.using(id,AbortSignal.timeout(240000),async page=>{
    await keep(dir+'/page.json',page);
    for(const asin of ['B01IAI2MB8','B0GHZDFNP8','B0GGVD471R']){
     const p=await new lib.AmazonEgoReader(page).product('https://www.amazon.com/dp/'+asin,AbortSignal.timeout(90000),raw=>keep(dir+'/'+asin+'.json',raw),'10001');
     const conditions=p.commerce.purchaseConditions;
     if(asin==='B01IAI2MB8'){assert.ok(p.galleryCount>=2);assert.equal(p.gallery[0].url,p.gallery[1].url);}
     else assert.equal(conditions.purchaseType,'one_time');
     if(asin==='B0GGVD471R')assert.ok(conditions.selectedOptions.some(o=>o.value==='120 Count (Pack of 2)'));
     const result={asin,galleryCount:p.galleryCount,uniqueImages:new Set(p.gallery.map(i=>i.url)).size,purchaseType:conditions.purchaseType,quantity:conditions.quantity,selectedOptions:conditions.selectedOptions};results.push(result);console.log(JSON.stringify(result));
    }
   });
  }catch(error){userControl=error?.message==='SOURCE.BROWSER_USER_CONTROL';throw error;}finally{
   // Idempotent exact-task cleanup; user control remains a stop in the page helper.
   if(!userControl){const closed=await pages.close(id,AbortSignal.timeout(20000));assert.equal(closed.status,'closed');await keep(dir+'/closed.json',closed);
    await gate.release(permit);released=true;}
  }
  await keep(dir+'/report.json',{passed:true,results,closed:true});
 }else if(mode==='vision'){
  const c=await read(m.jobs.find(j=>j.id==='amazon-channel-label-vision').env.V3_CHANNEL_LABEL_CONFIG),a=await read(work+'/evidence/artifacts.json');
  provider=await lib.CodexVisionProvider.open({...c.codex,workRoot:dir+'/model'}, {...process.env,PATH:'/opt/homebrew/bin:'+process.env.PATH});
  const results=[];
  for(const hash of ['da6123144437615ce80da0b4a85ccd453c39d077a5f897b298b32feb264e0ab9','40720b7fc6187faaf62af48f7ae70fa54f0455a8a35f8af637504ab04c02fde5']){
   const f=a.find(f=>f.ref.sha256===hash);assert.ok(f);const start=Date.now(),bytes=await fs.readFile(work+'/evidence/'+f.file);
   const raw=await provider.interpret(f.ref,bytes,AbortSignal.timeout(c.codex.timeoutMs));await keep(dir+'/'+f.ref.listingId+'-raw.json',JSON.parse(raw));
   const decoded=c.codex.extractionProtocol==='label-extraction/2'?lib.decodeLabelImageV2(raw):lib.decodeLabelImage(raw);await keep(dir+'/'+f.ref.listingId+'-decoded.json',decoded);
   const result={asin:f.ref.listingId,status:decoded.status,codes:decoded.codes,durationMs:Date.now()-start,formula:decoded.candidate.formula?.columns.map(c=>c.rows.map(r=>({kind:r.kind,name:r.name.text,amount:r.amount?.text,parent:r.parentRowIndex}))),equivalentLines:decoded.candidate.exclusions.filter(e=>/equivalent/i.test(e.quote.text))};results.push(result);console.log(JSON.stringify(result));
  }
  await provider.close();provider=null;await gate.release(permit);released=true;
  await keep(dir+'/report.json',{passed:results.every(r=>r.status==='candidate'&&r.equivalentLines.length>0),fingerprint:lib.CodexVisionProvider.describe(c.codex).configFingerprint,results});
 }else throw Error('MODE');
}finally{await provider?.close();if(mode==='vision'&&held&&!released)await gate.release(permit);await db.end();}
