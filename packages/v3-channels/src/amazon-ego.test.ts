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
