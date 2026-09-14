import{expect,it,vi}from'vitest';import{runInNewContext}from'node:vm';import{AmazonEgoReader,amazonCatalogExpression}from'./amazon-ego.js';import{amazonFixture}from'./amazon-live.fixture.js';
import {amazonProductExpression} from './amazon-ego.js';
const config={engine:'ego-lite',sdk:'1',cliPath:'/test/ego',taskSpaceId:1,targetId:'owned',sessionId:'session'} as const;
it('executes generated catalog transport script and its readiness expression before returning a validated public projection',async()=>{const f=amazonFixture(),navigate=vi.fn(),select=vi.fn();const runner={run:async(_cli:string,script:string)=>runInNewContext(`(async()=>{${script};return snapshot;})()`,{useOrCreateTaskSpace:async()=>{},listTabs:async()=>[{targetId:'owned',url:'about:blank'}],switchTab:select,gotoAndWait:navigate,js:async(expression:string)=>{if(expression===amazonCatalogExpression)return f.projection;return runInNewContext(expression,{document:{querySelector:(selector:string)=>{expect(selector).toBe('ul[class*="ProductGrid__grid__"] li');return{};}}});}})};expect(await new AmazonEgoReader(config,runner).catalog(f.store,'UNIQUE E',AbortSignal.timeout(3000))).toEqual(f.projection);expect(select).toHaveBeenCalledWith('owned');expect(navigate).toHaveBeenCalledOnce();});
it('missing exact owned target stops before navigation',async()=>{const f=amazonFixture(),navigate=vi.fn();const runner={run:async(_c:string,script:string)=>runInNewContext(`(async()=>{${script};return snapshot;})()`,{useOrCreateTaskSpace:async()=>{},listTabs:async()=>[{targetId:'user',url:f.store}],gotoAndWait:navigate})};await expect(new AmazonEgoReader(config,runner).catalog(f.store,'UNIQUE E',AbortSignal.timeout(3000))).rejects.toThrow('EGO_TARGET_MISMATCH');expect(navigate).not.toHaveBeenCalled();});
it('wrong delivery ZIP stops before gallery interaction',async()=>{const f=amazonFixture(),cdp=vi.fn();const runner={run:async(_c:string,script:string)=>runInNewContext(`(async()=>{${script};return snapshot;})()`,{useOrCreateTaskSpace:async()=>{},listTabs:async()=>[{targetId:'owned',url:f.url}],switchTab:async()=>{},cdp,js:async(expression:string)=>expression.includes("codec:'amazon-rendered/1'")?f.product:true})};await expect(new AmazonEgoReader(config,runner).product(f.url,AbortSignal.timeout(3000),undefined,'10001')).rejects.toThrow('DELIVERY_CONTEXT_CONFLICT');expect(cdp).not.toHaveBeenCalled();});

// Observed Amazon purchase forms repeat #ASIN for one-time and subscription offers.
function productDom(asins:string[]){
 const root={querySelectorAll:(s:string)=>s==='#ASIN'?asins.map(value=>({value})):s==='#productTitle'?[{innerText:'Observed product'}]:[],querySelector:()=>null};
 return {querySelectorAll:(s:string)=>s==='#ppd'?[root]:[],querySelector:(s:string)=>s==='#ppd'?root:null,getElementById:()=>null};
}
it('identical selected ASINs in repeated purchase forms identify one product',()=>{
 const p=runInNewContext(amazonProductExpression,{document:productDom(['B0G963NB8Q','B0G963NB8Q']),location:{href:'https://www.amazon.com/dp/B0G963NB8Q'}});
 expect(p.asin).toBe('B0G963NB8Q');expect(p.title).toBe('Observed product');
});
it.each([['B0G963NB8Q','B0013LAQS6'],['B0G963NB8Q',''],[]])('conflicting or incomplete purchase-form identity remains rejected (%j)',(...asins)=>{
 expect(()=>runInNewContext(amazonProductExpression,{document:productDom(asins as string[]),location:{href:'https://www.amazon.com/dp/B0G963NB8Q'}})).toThrow(/AMAZON\.(ASIN_CONFLICT|PRODUCT_UNVERIFIED)/);
});
function galleryRunner(duplicate:boolean,stale=false){
 const f=amazonFixture();let selected=0;
 const thumbnail=(i:number)=>`url(https://m.media-amazon.com/images/I/thumb${duplicate&&i===1?0:i}.jpg)`;
 const node=(i:number)=>({scrollIntoView:()=>{},getBoundingClientRect:()=>({x:i*10,y:0,width:2,height:2}),
  classList:{contains:()=>selected===i},querySelector:()=>({style:{backgroundImage:thumbnail(i)}})});
 const document={querySelectorAll:(s:string)=>s.includes('#ivThumbs')?[node(0),node(1),node(2)]:[node(s==='#landingImage'?-1:Number(s.replace('#ivImage_','')))],
  querySelector:(s:string)=>s==='#landingImage'?{complete:true}:s==='#ASIN'?{}:s==='#ivLargeImage img'?{complete:true,naturalWidth:1280,src:`https://m.media-amazon.com/images/I/original${stale?0:duplicate&&selected===1?0:selected}.jpg`,alt:''}:node(Number(s.replace('#ivImage_','')))};
 return {f,runner:{run:async(_c:string,script:string)=>runInNewContext(`(async()=>{${script};return snapshot;})()`,{
  useOrCreateTaskSpace:async()=>{},listTabs:async()=>[{targetId:'owned',url:f.url}],switchTab:async()=>{},
  js:async(expression:string)=>expression===amazonProductExpression?f.product:runInNewContext(expression,{document}),
  cdp:async(_method:string,p:{type:string;x:number})=>{if(p.type==='mouseReleased'&&p.x>0)selected=Math.floor(p.x/10);},
  setTimeout:(fn:()=>void)=>fn(),
 })}};
}
it('accepts two selected gallery positions showing the same original when their public thumbnails agree',async()=>{
 const {f,runner}=galleryRunner(true);const p=await new AmazonEgoReader(config,runner).product(f.url,AbortSignal.timeout(3000));
 expect(p.galleryCount).toBe(3);expect(p.gallery[0]!.url).toBe(p.gallery[1]!.url);expect(p.gallery[2]!.url).not.toBe(p.gallery[1]!.url);
});
it('still rejects a stale original after selecting a different thumbnail',async()=>{
 const {f,runner}=galleryRunner(false,true);await expect(new AmazonEgoReader(config,runner).product(f.url,AbortSignal.timeout(3000))).rejects.toThrow('AMAZON.GALLERY_UNVERIFIED');
});
