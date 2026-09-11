import{it,expect}from'vitest';import{ChannelPlanInputSchema}from'@crawl-automation/v3-contracts';import{parseDtcRenderedProduct,dtcAddress}from'./dtc-rendered.js';import{DtcCatalogSource}from'./dtc-catalog-source.js';import{DtcLiveProduct}from'./dtc-live-product.js';import{dtcFixture,DtcMemory,RetainedPublication}from'./dtc-live.fixture.js';
const signal=()=>AbortSignal.timeout(3000);
it('stable selected URL identity ignores fragments but preserves variant query',()=>{const f=dtcFixture();expect(dtcAddress(f.url+'#label')).toEqual(dtcAddress(f.url));expect(dtcAddress(f.url+'?variant=2').listingId).not.toBe(f.listingId);expect(()=>dtcAddress('http://127.0.0.1/product')).toThrow();});
it.each(['url','owner','missing-image','variant'])('rejects %s identity/evidence corruption',mode=>{const f=dtcFixture(),p=structuredClone(f.product),owner={listingId:p.listingId,variantId:null as string|null};if(mode==='url')p.url+='-other';if(mode==='owner')owner.listingId='dtc-other';if(mode==='missing-image')p.images=[];if(mode==='variant')owner.variantId='2';expect(()=>parseDtcRenderedProduct(p,f.url,owner)).toThrow();});
it('escapes retained text and marks selected-only coverage',()=>{const f=dtcFixture();f.product.sections=['<script>bad()</script>'];const p=parseDtcRenderedProduct(f.product,f.url,{listingId:f.listingId,variantId:null});expect(p.detailsHtml).not.toContain('<script>');expect(p.warnings).toContain('DTC.COVERAGE_UNVERIFIED');});
it('catalog cold read never navigates and never claims complete coverage',async()=>{const f=dtcFixture(),p=await f.catalog.read(f.input,signal());expect(p.completion).toBe('unknown');expect(p.entries).toHaveLength(1);const cold=new DtcCatalogSource(new RetainedPublication(new DtcMemory(),f.remote),f.policy);expect(await cold.read(f.input,signal())).toEqual(p);expect(f.browser.capture).toHaveBeenCalledOnce();await expect(cold.verify({...p,completion:'complete',endEvidence:p.source},signal())).rejects.toThrow();});
it('failed cleanup cannot publish ready or recapture',async()=>{const f=dtcFixture(),c=new DtcCatalogSource(f.publication,f.policy,{capture:async(_i,_s,retain)=>{await retain(f.projection);throw Error('SOURCE.PAGE_CLOSE_UNKNOWN');}});await expect(c.read(f.input,signal())).rejects.toThrow('PAGE_CLOSE_UNKNOWN');expect(await c.inspect(f.input,signal())).toBeNull();await expect(c.read(f.input,signal())).rejects.toThrow('CAPTURE_UNRESOLVED');});
it('configured next page must be observed in current navigation',async()=>{const f=dtcFixture(),c=new DtcCatalogSource(f.publication,{...f.policy,pages:[f.store,f.store+'?page=2']},f.browser);await expect(c.read(f.input,signal())).rejects.toThrow('NAVIGATION_UNVERIFIED');});
it('an explicitly selected variant of an observed canonical product keeps its full URL identity and cold evidence',async()=>{
 const f=dtcFixture(),url=f.url+'?variant=44807968882774',policy={...f.policy,selectedUrls:[url]};
 const c=new DtcCatalogSource(f.publication,policy,f.browser),page=await c.read(f.input,signal());
 expect(page.entries).toEqual([{...dtcAddress(url),variantId:null,kind:'product'}]);
 expect(page.entries[0]!.listingId).not.toBe(f.listingId);
 const cold=new DtcCatalogSource(new RetainedPublication(new DtcMemory(),f.remote),policy);
 expect(await cold.read(f.input,signal())).toEqual(page);expect(f.browser.capture).toHaveBeenCalledOnce();
});
it.each(['https://other.example/products/one','https://brand.example/products/two'])('selected URL cannot introduce an unobserved product: %s',async url=>{
 const f=dtcFixture(),c=new DtcCatalogSource(f.publication,{...f.policy,selectedUrls:[url]},f.browser);
 expect((await c.read(f.input,signal())).entries).toEqual([]);
});
it('an observed variant cannot authorize a different selected variant',async()=>{
 const f=dtcFixture();Object.assign(f.projection.entries[0]!,dtcAddress(f.url+'?variant=1'));
 const c=new DtcCatalogSource(f.publication,{...f.policy,selectedUrls:[f.url+'?variant=2']},f.browser);
 expect((await c.read(f.input,signal())).entries).toEqual([]);
});
it('DTC reuses saved page and original file plans without recapture',async()=>{const f=dtcFixture(),j=await f.job(),capture=await f.live.capture(j,signal());expect(capture.sourcePlan).toMatchObject({channel:'dtc',owner:{listingId:f.listingId,variantId:null}});expect(await f.plans.run(capture.sourcePlan,signal())).toMatchObject({status:'prepared'});const p=await f.plans.inspect(capture.sourcePlan,signal());expect(p!.files).toHaveLength(2);expect(p!.manifest.sources).toHaveLength(3);const cold=new DtcLiveProduct(new RetainedPublication(new DtcMemory(),f.remote),f.settings);expect(await cold.capture(j,signal())).toEqual(capture);expect(f.productBrowser.capture).toHaveBeenCalledOnce();expect(ChannelPlanInputSchema.safeParse({...capture.sourcePlan,parserVersion:'swanson-rendered/1'}).success).toBe(false);});
it('capture loss preserves intent and denies a second model/browser call',async()=>{const f=dtcFixture(),j=await f.job();f.productBrowser.capture.mockRejectedValue(Error('lost'));await expect(f.live.capture(j,signal())).rejects.toThrow('lost');await expect(f.live.capture(j,signal())).rejects.toThrow('CAPTURE_UNRESOLVED');expect(f.productBrowser.capture).toHaveBeenCalledOnce();});
