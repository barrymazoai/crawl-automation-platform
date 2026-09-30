import{it,expect}from'vitest';import{ChannelPlanInputSchema}from'@crawl-automation/v3-contracts';import{parseAmazonRenderedProduct,parseAmazonRenderedCatalog,amazonProductAddress,amazonStoreAddress}from'./amazon-rendered.js';import{AmazonCatalogSource}from'./amazon-catalog-source.js';import{AmazonLiveProduct}from'./amazon-live-product.js';import{amazonFixture,AmazonMemory,RetainedPublication}from'./amazon-live.fixture.js';
const signal=()=>AbortSignal.timeout(3000);
it('observed titled canonical URLs preserve the selected ASIN',()=>{
 const f=amazonFixture();f.product.canonicalUrl='https://www.amazon.com/UNIQUE-E-Softgels/dp/B000REPUY0';
 expect(parseAmazonRenderedProduct(f.product,f.url,{listingId:f.product.asin,variantId:null}).listingId).toBe('B000REPUY0');
 expect(amazonProductAddress(f.product.canonicalUrl).url).toBe(f.url);
 f.product.canonicalUrl='https://www.amazon.com/UNIQUE-E-Softgels/dp/B000000002';
 expect(()=>parseAmazonRenderedProduct(f.product,f.url,{listingId:f.product.asin,variantId:null})).toThrow('ASIN_CONFLICT');
});
it.each(['https://evil.example/title/dp/B000REPUY0','https://www.amazon.com/title/extra/dp/B000REPUY0','https://www.amazon.com/title/dp/B000REPUY0X'])('does not loosen ASIN route or origin validation for %s',url=>{expect(()=>amazonProductAddress(url)).toThrow();});
it('accepts localized public store/ASIN links and rejects other origins',()=>{expect(amazonProductAddress('https://www.amazon.com/-/zh/dp/B000REPUY0?ref=x').asin).toBe('B000REPUY0');expect(amazonStoreAddress(amazonFixture().store).id).toBe('7B3902F7-D6C8-4226-97B1-BEB72807BEB3');expect(()=>amazonProductAddress('https://evil.example/dp/B000REPUY0')).toThrow();});
it.each(['asin','canonical','owner','missing','index','host','section'])('rejects %s identity or gallery corruption',mode=>{const f=amazonFixture(),p=structuredClone(f.product),owner={listingId:p.asin,variantId:null};if(mode==='asin')p.asin='B000000002';if(mode==='canonical')p.canonicalUrl='https://www.amazon.com/dp/B000000002';if(mode==='owner')owner.listingId='B000000002';if(mode==='missing')p.gallery.pop();if(mode==='index')p.gallery[1]!.index=0;if(mode==='host')p.gallery[0]!.url='https://evil.example/label.jpg';if(mode==='section')p.sections.push(p.sections[0]!);expect(()=>parseAmazonRenderedProduct(p,f.url,owner)).toThrow();});
it('keeps complete gallery selection evidence while deduplicating repeated original bytes URLs',()=>{const f=amazonFixture();f.product.gallery[1]!.url=f.product.gallery[0]!.url;const p=parseAmazonRenderedProduct(f.product,f.url,{listingId:f.product.asin,variantId:null});expect(p.imageCandidates).toHaveLength(1);expect(p.warnings).toContain('AMAZON.SELECTED_ASIN_ONLY');});
it('store cards exclude sponsored entries, reject conflicting ASINs and never prove absence',()=>{const f=amazonFixture();expect(parseAmazonRenderedCatalog(f.projection,f.store,'UNIQUE E')).toMatchObject({completion:'unknown',entries:[{listingId:'B000REPUY0'}]});f.projection.cards[0]!.links.push('https://www.amazon.com/dp/B000000003');expect(()=>parseAmazonRenderedCatalog(f.projection,f.store,'UNIQUE E')).toThrow('ASIN_CONFLICT');});
it('durable catalog closes its browser phase before ready and cold retries never navigate',async()=>{const f=amazonFixture(),p=await f.catalog.read(f.input,signal());expect(p.completion).toBe('unknown');expect(p.entries).toHaveLength(1);const cold=new AmazonCatalogSource(new RetainedPublication(new AmazonMemory(),f.remote),f.policy);expect(await cold.read(f.input,signal())).toEqual(p);expect(f.browser.capture).toHaveBeenCalledOnce();await expect(cold.verify({...p,completion:'complete',endEvidence:p.source},signal())).rejects.toThrow();});
it('failed cleanup cannot publish ready or silently recapture',async()=>{const f=amazonFixture();const c=new AmazonCatalogSource(f.publication,f.policy,{capture:async(_i,_s,retain)=>{await retain(f.projection);throw Error('SOURCE.PAGE_CLOSE_UNKNOWN');}});await expect(c.read(f.input,signal())).rejects.toThrow('PAGE_CLOSE_UNKNOWN');expect(await c.inspect(f.input,signal())).toBeNull();await expect(c.read(f.input,signal())).rejects.toThrow('CAPTURE_UNRESOLVED');});
it('configured next store page must be linked by the current public navigation',async()=>{const f=amazonFixture(),next='https://www.amazon.com/stores/page/8C762F00-E70B-43FD-9C94-CA260692DB5B';const c=new AmazonCatalogSource(f.publication,{...f.policy,pages:[f.store,next]},f.browser);await expect(c.read(f.input,signal())).rejects.toThrow('NAVIGATION_UNVERIFIED');});
it('selected ASIN produces page and original image tasks using the common plan and cold source',async()=>{const f=amazonFixture(),j=await f.job(),capture=await f.live.capture(j,signal());expect(capture.sourcePlan).toMatchObject({channel:'amazon',owner:{listingId:'B000REPUY0',variantId:null}});expect(await f.plans.run(capture.sourcePlan,signal())).toMatchObject({status:'prepared'});const p=await f.plans.inspect(capture.sourcePlan,signal());expect(p!.files).toHaveLength(2);expect(p!.manifest.sources).toHaveLength(3);const cold=new AmazonLiveProduct(new RetainedPublication(new AmazonMemory(),f.remote),f.settings);expect(await cold.capture(j,signal())).toEqual(capture);expect(f.productBrowser.capture).toHaveBeenCalledOnce();expect(ChannelPlanInputSchema.safeParse({...capture.sourcePlan,parserVersion:'swanson-rendered/1'}).success).toBe(false);});
it('capture loss keeps its intent without a second browser call',async()=>{const f=amazonFixture(),j=await f.job();f.productBrowser.capture.mockRejectedValue(Error('lost'));await expect(f.live.capture(j,signal())).rejects.toThrow('lost');await expect(f.live.capture(j,signal())).rejects.toThrow('CAPTURE_UNRESOLVED');expect(f.productBrowser.capture).toHaveBeenCalledOnce();});
it('foreign selected ASIN cannot create an observation',async()=>{const f=amazonFixture(),j=await f.job();f.product.asin='B000000002';await expect(f.live.capture(j,signal())).rejects.toThrow('IDENTITY_UNVERIFIED');});

it('observed localized clp canonical is an identity alias, never a product navigation route',()=>{const f=amazonFixture();f.product.canonicalUrl='https://www.amazon.com/-/zh/clp/B000REPUY0';expect(parseAmazonRenderedProduct(f.product,f.url,{listingId:f.product.asin,variantId:null}).listingId).toBe('B000REPUY0');expect(()=>amazonProductAddress(f.product.canonicalUrl)).toThrow();});
it('loading placeholders must not be retained as original gallery images',()=>{const f=amazonFixture();f.product.gallery[1]!.url='https://m.media-amazon.com/images/G/01/loading.gif';expect(()=>parseAmazonRenderedProduct(f.product,f.url,{listingId:f.product.asin,variantId:null})).toThrow('IMAGE_URL_REJECTED');});

it('binds files to the retained observed URL without changing historical capture inputs',async()=>{
 const f=amazonFixture(),job=await f.job();f.product.url=f.url+'?th=1';
 const captured=await f.live.capture(job,signal()),before=JSON.stringify(captured);
 const cold=new AmazonLiveProduct(new RetainedPublication(new AmazonMemory(),f.remote),f.settings);
 expect(await cold.filePageUrl(captured,signal())).toBe(f.url+'?th=1');
 expect(await cold.inspect(job,signal())).toEqual(captured);
 expect(captured.sourcePlan.expectedUrl).toBe(f.url);expect(JSON.stringify(captured)).toBe(before);
 expect(f.productBrowser.capture).toHaveBeenCalledOnce();
});
it.each(['hash','owner','session','projection','missing','intent'])('rejects a %s conflict before issuing a file page binding',async mode=>{
 const f=amazonFixture(),captured=await f.live.capture(await f.job(),signal());
 if(mode==='hash')captured.sourcePlan.source.sha256='0'.repeat(64);
 if(mode==='owner')captured.sourcePlan.owner.observationId='foreign-observation';
 if(mode==='session')captured.sourcePlan.binding.sessionId='foreign-session';
 if(mode==='projection')f.remote.data.set(captured.sourcePlan.source.objectKey,Buffer.from(JSON.stringify({...f.product,url:f.url+'?th=1'})));
 if(mode==='missing')f.remote.data.delete(captured.sourcePlan.source.objectKey);
 if(mode==='intent')f.remote.data.delete(`v3/amazon-products/${captured.job.operationId}/intent.json`);
 await expect(f.live.filePageUrl(captured,signal())).rejects.toThrow();
});
it.each(['https://evil.example/dp/B000REPUY0','https://www.amazon.com/dp/B000000002'])('rejects an observed foreign product/origin %s',async url=>{
 const f=amazonFixture(),job=await f.job();f.product.url=url;
 await expect(f.live.capture(job,signal())).rejects.toThrow();
});
it('a page retained by a price-only pass is reused when the product resumes through the full pipeline',async()=>{
 const f=amazonFixture(),full=await f.job(),priced={...full,stopAfter:'observation' as const};
 const captured=await f.live.capture(priced,signal());
 expect(f.productBrowser.capture).toHaveBeenCalledOnce();
 const resumed=await f.live.inspect(full,signal());
 // Same retained page, no second fetch: only where the run stops has changed.
 expect(resumed).not.toBeNull();
 expect(resumed!.sourcePlan.source.objectKey).toBe(captured.sourcePlan.source.objectKey);
 expect(f.productBrowser.capture).toHaveBeenCalledOnce();
 // Everything else in the job is still identity: a different session is still a conflict.
 await expect(f.live.inspect({...full,sessionId:'amazon-page-other'},signal())).rejects.toThrow('AMAZON.PRODUCT_POLICY_CONFLICT');
});
