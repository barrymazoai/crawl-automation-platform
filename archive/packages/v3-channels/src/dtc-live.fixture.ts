import{vi}from'vitest';import{DtcProductJobSchema}from'@crawl-automation/v3-contracts';import{RetainedPublication}from'@crawl-automation/v3-artifacts';import{swansonLiveFixture,SwansonMemory}from'./swanson-live.fixture.js';import{DtcLiveProduct}from'./dtc-live-product.js';import{DtcCatalogSource}from'./dtc-catalog-source.js';import{dtcAddress}from'./dtc-rendered.js';
export function dtcFixture(){const f=swansonLiveFixture(),url='https://brand.example/products/one',store='https://brand.example/collections/all',listingId=dtcAddress(url).listingId;
 const scope={...f.scope,channel:'dtc' as const,rootUrl:store},input={...f.input,scope};
 const projection={codec:'dtc-catalog-rendered/1',url:store,brandName:'Example',entries:[{url,listingId,variantId:null,title:'One'}],navigation:[],snapshotKeys:['v3/snapshot.json']};
 const product={codec:'dtc-rendered/1',url,listingId,brandName:'Example',title:'One',sections:['Other ingredients: gelatin, glycerin, water'],images:['https://brand.example/front.jpg','https://brand.example/label.jpg'],selectedOnly:true,snapshotKeys:['v3/snapshot.json']};
 const browser={capture:vi.fn(async()=>projection)},productBrowser={capture:vi.fn(async()=>product)},policy={brandName:'Example',pages:[store],selectedUrls:null};
 const catalog=new DtcCatalogSource(f.publication,policy,browser),live=new DtcLiveProduct(f.publication,f.settings,productBrowser);
 const job=async()=>{const base=await f.job();return DtcProductJobSchema.parse({codec:'dtc-product-job/1',sessionId:'dtc-page',operationId:'dtc-capture',discovery:{...base.discovery,scope,entry:{listingId,variantId:null,url,kind:'product'}},queues:base.queues,resources:{...base.resources,activities:{...base.resources.activities,captureDtcProduct:[{resourceId:'model',units:1}]}}});};
 return{...f,url,store,listingId,scope,input,projection,product,browser,productBrowser,policy,catalog,live,job};}
export{SwansonMemory as DtcMemory,RetainedPublication};
