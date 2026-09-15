// Read-only throughput/completeness benchmark: fetch Amazon product pages through ScraperAPI.
// Usage: SCRAPERAPI_KEY=... node bench-scraperapi-amazon.mjs --plan <temporal-plan.json> [--asins file] --count 100 --concurrency 50 --out <dir> [--render] [--structured 10] [--force]
// Does not touch Temporal, the database, R2 or any Worker. Writes only into --out.
import fs from 'node:fs/promises';
import path from 'node:path';
const arg=(k,d)=>{const i=process.argv.indexOf('--'+k);return i>0&&process.argv[i+1]&&!process.argv[i+1].startsWith('--')?process.argv[i+1]:d;};
const flag=k=>process.argv.includes('--'+k);
const key=process.env.SCRAPERAPI_KEY;if(!key)throw Error('SCRAPERAPI_KEY missing');
const count=Number(arg('count','100')),concurrency=Number(arg('concurrency','50')),out=arg('out',`/tmp/scraperapi-bench-${Date.now()}`),render=flag('render'),structuredN=Number(arg('structured','0'));
await fs.mkdir(out,{recursive:true});
let asins=[];
if(arg('plan')){const plan=JSON.parse(await fs.readFile(arg('plan'),'utf8'));asins=plan.products.map(p=>p.asin);}
else if(arg('asins')){asins=(await fs.readFile(arg('asins'),'utf8')).split(/\s+/).filter(Boolean);}
asins=[...new Set(asins)].slice(0,count);if(!asins.length)throw Error('no ASINs');
const account=async()=>{const r=await fetch(`https://api.scraperapi.com/account?api_key=${key}`);return r.json();};
const before=await account();
console.log('account:',JSON.stringify({concurrencyLimit:before.concurrencyLimit,requestLimit:before.requestLimit,creditsLeft:before.creditsLeft,requestCount:before.requestCount}));
const need=asins.length*(render?50:5)+structuredN*5;
if(before.creditsLeft!==undefined&&before.creditsLeft<need&&!flag('force')){console.log(`ABORT: creditsLeft ${before.creditsLeft} < estimated need ${need} (use --force to override)`);process.exit(2);}
const conc=Math.min(concurrency,before.concurrencyLimit||concurrency);
const m=(re,s)=>{const x=s.match(re);return x?x[1].replace(/\s+/g,' ').trim():null;};
const checks=html=>({
 captcha:/Robot Check|validateCaptcha|api-services-support@amazon\.com/.test(html),
 title:m(/id="productTitle"[^>]*>\s*([^<]{3,300})/,html),
 price:m(/id="corePrice_feature_div"[\s\S]{0,3000}?class="a-offscreen">([^<]+)</,html)||m(/class="a-price[^"]*"[^>]*>\s*<span class="a-offscreen">([^<]+)</,html),
 hiRes:(html.match(/"hiRes":"https:[^"]+"/g)||[]).length,
 sl1500:new Set(html.match(/https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9+%._-]+\._AC_SL1500_\.jpg/g)||[]).size,
 deliverTo:m(/id="glow-ingress-line2"[^>]*>\s*([^<]+)/,html),
 buybox:/id="buybox"/.test(html),accordion:/id="buyBoxAccordion"/.test(html),
 oneTime:/One-time purchase/i.test(html),subscribe:/Subscribe\s*(&amp;|&)\s*Save/i.test(html),
 addToCart:/id="add-to-cart-button"/.test(html),seller:m(/id="sellerProfileTriggerId"[^>]*>([^<]+)</,html),shipsFrom:/Ships from/i.test(html),
 unavailable:/Currently unavailable/i.test(html),ingredients:/Ingredients/i.test(html),
});
const results=[];let started=0;const t0=Date.now();
const one=async asin=>{
 const url=`https://api.scraperapi.com/?api_key=${key}&url=${encodeURIComponent('https://www.amazon.com/dp/'+asin)}&country_code=us${render?'&render=true':''}`;
 const s=Date.now();const r={asin,startedAtMs:s-t0};
 try{const res=await fetch(url,{signal:AbortSignal.timeout(120000)});const html=await res.text();r.status=res.status;r.ms=Date.now()-s;r.bytes=html.length;
  r.creditCost=res.headers.get('sa-credit-cost')||res.headers.get('x-credit-cost')||null;r.finalUrl=res.headers.get('sa-final-url')||null;
  if(res.status===200){Object.assign(r,checks(html));await fs.writeFile(path.join(out,`${asin}.html`),html);}else r.body=html.slice(0,200);
 }catch(e){r.error=String(e.message||e).slice(0,120);r.ms=Date.now()-s;}
 results.push(r);process.stdout.write(`${String(results.length).padStart(3)}/${asins.length} ${asin} ${r.status??'ERR'} ${r.ms}ms${r.captcha?' CAPTCHA':''}${r.status===200&&!r.title?' NO-TITLE':''}\n`);
};
await Promise.all(Array.from({length:conc},async()=>{while(started<asins.length){const a=asins[started++];await one(a);}}));
const wall=(Date.now()-t0)/1000;
const ok=results.filter(r=>r.status===200&&!r.captcha&&r.title),lat=results.filter(r=>r.ms).map(r=>r.ms).sort((a,b)=>a-b),q=p=>lat[Math.min(lat.length-1,Math.floor(p*lat.length))];
const pct=f=>ok.length?Math.round(100*ok.filter(f).length/ok.length)+'%':'n/a';
const summary={mode:render?'render':'plain',requested:asins.length,concurrencyUsed:conc,wallSeconds:+wall.toFixed(1),pagesPerMinute:+(60*results.length/wall).toFixed(1),
 status:Object.fromEntries(Object.entries(results.reduce((a,r)=>{const k=r.status??'error';a[k]=(a[k]||0)+1;return a;},{}))),
 usable:ok.length,captcha:results.filter(r=>r.captcha).length,latencyMs:{p50:q(.5),p90:q(.9),max:lat.at(-1)},
 completeness:{price:pct(r=>r.price),hiResImages:pct(r=>r.hiRes>0),sl1500Images:pct(r=>r.sl1500>0),buybox:pct(r=>r.buybox),accordionOrOneTime:pct(r=>r.accordion||r.oneTime),subscribeSeen:pct(r=>r.subscribe),addToCart:pct(r=>r.addToCart),seller:pct(r=>r.seller),shipsFrom:pct(r=>r.shipsFrom),deliverTo:pct(r=>r.deliverTo),ingredientsWord:pct(r=>r.ingredients)},
 deliverToSamples:[...new Set(ok.map(r=>r.deliverTo).filter(Boolean))].slice(0,5),avgHiResPerPage:ok.length?+(ok.reduce((a,r)=>a+r.hiRes,0)/ok.length).toFixed(1):null,
 creditCostHeaderSamples:[...new Set(results.map(r=>r.creditCost).filter(Boolean))].slice(0,3)};
let structured=null;
if(structuredN>0){structured=[];for(const asin of asins.slice(0,structuredN)){const s=Date.now();try{const res=await fetch(`https://api.scraperapi.com/structured/amazon/product?api_key=${key}&asin=${asin}&country=us&tld=com`,{signal:AbortSignal.timeout(120000)});const text=await res.text();let j=null;try{j=JSON.parse(text);}catch{}
  await fs.writeFile(path.join(out,`${asin}.structured.json`),text);
  structured.push({asin,status:res.status,ms:Date.now()-s,keys:j?Object.keys(j).slice(0,40):null,price:j?.pricing??j?.price??null,listPrice:j?.list_price??null,images:Array.isArray(j?.images)?j.images.length:null,sampleImage:Array.isArray(j?.images)?j.images[0]:null,availability:j?.availability_status??null,buybox:j?.buybox??null,seller:j?.seller??j?.ships_from??null});}
  catch(e){structured.push({asin,error:String(e.message).slice(0,100)});}}}
const after=await account();
summary.creditsUsed=(before.requestCount!==undefined&&after.requestCount!==undefined)?after.requestCount-before.requestCount:null;summary.creditsLeftAfter=after.creditsLeft;
await fs.writeFile(path.join(out,'results.json'),JSON.stringify({summary,structured,results},null,1));
console.log('\nSUMMARY '+JSON.stringify(summary,null,1));if(structured)console.log('STRUCTURED '+JSON.stringify(structured,null,1));console.log('out:',out);
