import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseHTML } from 'linkedom';
import { parseAmazonStaticHtml } from './amazon-http.js';
import { parseAmazonRenderedProduct } from './amazon-rendered.js';
import { AmazonLiveProduct } from './amazon-live-product.js';
import { amazonFixture, AmazonMemory, RetainedPublication } from './amazon-live.fixture.js';
const signal = () => AbortSignal.timeout(5000);

it.each(['missing', 'text-only', 'anchor-without-href'])('retains an absent store link from real HTML (%s) without inventing a URL', mode => {
  const html = gunzipSync(readFileSync(new URL('./fixtures/amazon-static-B0G963NB8Q.html.gz', import.meta.url))).toString();
  const { document } = parseHTML(html), byline = document.querySelector('#bylineInfo')!;
  expect(byline).not.toBeNull();
  if (mode === 'missing') byline.remove();
  else if (mode === 'anchor-without-href') byline.removeAttribute('href');
  else { const text = document.createElement('span'); text.id = byline.id; text.textContent = byline.textContent; byline.replaceWith(text); }
  const url = 'https://www.amazon.com/dp/B0G963NB8Q', p = parseAmazonStaticHtml(document.toString(), url);
  expect(p.storeUrl).toBeNull(); expect(p.galleryCount).toBe(7);
  expect(parseAmazonRenderedProduct(p, url, { listingId: p.asin, variantId: null }).listingId).toBe(p.asin);
});

it('an explicitly registered ASIN import can prepare and cold-read retained evidence with no store link', async () => {
  const f = amazonFixture(), job = await f.job();
  job.discovery.scope.rootUrl = 'https://www.amazon.com/';
  job.discovery.source.producer = { ...job.discovery.source.producer, module: 'amazon.link-list', implementationVersion: 'amazon-link-batch/1' };
  const { storeUrl: _absent, ...observed } = f.product;
  const live = new AmazonLiveProduct(f.publication, f.settings, { capture: async () => observed }, [job.discovery.catalogId]);
  const captured = await live.capture(job, signal());
  expect(JSON.parse(Buffer.from(f.remote.data.get(captured.sourcePlan.source.objectKey)!).toString()).storeUrl).toBeNull();
  expect(await f.plans.run(captured.sourcePlan, signal())).toMatchObject({ status: 'prepared' });
  const cold = new AmazonLiveProduct(new RetainedPublication(new AmazonMemory(), f.remote), f.settings, undefined, [job.discovery.catalogId]);
  expect(await cold.inspect(job, signal())).toEqual(captured);
  expect(await cold.filePageUrl(captured, signal())).toBe(f.url);
});

it.each(['store-scope', 'unregistered', 'wrong-producer', 'wrong-version'])('missing store evidence cannot bypass %s authorization', async mode => {
  const f = amazonFixture(), job = await f.job();
  if (mode !== 'store-scope') job.discovery.source.producer = { ...job.discovery.source.producer,
    module: mode === 'wrong-producer' ? 'amazon.browser-projection' : 'amazon.link-list',
    implementationVersion: mode === 'wrong-version' ? 'amazon-link-batch/2' : 'amazon-link-batch/1' };
  const live = new AmazonLiveProduct(f.publication, f.settings, { capture: async () => ({ ...f.product, storeUrl: null }) }, mode === 'unregistered' ? [] : [job.discovery.catalogId]);
  await expect(live.capture(job, signal())).rejects.toThrow('AMAZON.IDENTITY_UNVERIFIED');
  expect(f.remote.data.has(`v3/amazon-products/${job.operationId}/projection.json`)).toBe(false);
});

it.each(['foreign-store', 'invalid-store', 'foreign-asin', 'foreign-origin'])('registered imports still reject %s', async mode => {
  const f = amazonFixture(), job = await f.job();
  job.discovery.source.producer = { ...job.discovery.source.producer, module: 'amazon.link-list', implementationVersion: 'amazon-link-batch/1' };
  const p = { ...f.product, storeUrl: null as string | null };
  if (mode === 'foreign-store') p.storeUrl = 'https://evil.example/stores/page/7B3902F7-D6C8-4226-97B1-BEB72807BEB3';
  if (mode === 'invalid-store') p.storeUrl = 'https://www.amazon.com/';
  if (mode === 'foreign-asin') p.asin = 'B000000002';
  if (mode === 'foreign-origin') p.url = 'https://evil.example/dp/B000REPUY0';
  const live = new AmazonLiveProduct(f.publication, f.settings, { capture: async () => p }, [job.discovery.catalogId]);
  await expect(live.capture(job, signal())).rejects.toThrow();
  expect(f.remote.data.has(`v3/amazon-products/${job.operationId}/projection.json`)).toBe(false);
});
