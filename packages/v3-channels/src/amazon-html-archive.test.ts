import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { ScraperApiTransport, type HttpRoute, type Response } from '@crawl-automation/v3-acquisition';
import { AmazonHtmlArchive } from './amazon-html-archive.js';
import { AmazonHttpReader } from './amazon-http.js';
import { AmazonLiveProduct } from './amazon-live-product.js';
import { amazonFixture, AmazonMemory, RetainedPublication } from './amazon-live.fixture.js';

const signal = () => AbortSignal.timeout(10000);
const asin = 'B0013LAQS6', url = `https://www.amazon.com/dp/${asin}`;
const html = () => gunzipSync(readFileSync(new URL('./fixtures/amazon-static-B0013LAQS6.html.gz', import.meta.url)));
async function setup(body: Uint8Array = html()) {
  const f = amazonFixture(), job = await f.job();
  job.discovery.entry = { ...job.discovery.entry, listingId: asin, url };
  const selection = { routeId: 'test', version: 'scraperapi/1', egressId: 'us/1', mode: 'scraperapi' as const,
    managed: true as const, countryCode: 'us', sessionNumber: null, responseMode: 'html' as const, providerPolicy: 'scraperapi-sync/1' as const };
  const get = vi.fn(async (): Promise<Response> => ({ status: 200, headers: { 'content-type': 'text/html' },
    body: (async function* () { yield body; })(), close() {} }));
  const transport = new ScraperApiTransport(selection, { apiKey: 'test-not-real', allowedOrigins: ['https://www.amazon.com'] }, get);
  const route: HttpRoute = { selection, transport, capabilities: transport.capabilities };
  return { ...f, job, get, route, reader: new AmazonHttpReader(route), archive: new AmazonHtmlArchive(f.publication, job) };
}
it('requires an archive before making any provider call', async () => {
  const f = await setup();
  await expect(f.reader.product(url, signal())).rejects.toThrow('HTML_ARCHIVE_REQUIRED');
  expect(f.get).not.toHaveBeenCalled();
});
it('publishes exact bytes and verified metadata before returning a projection; a cold reader never fetches again', async () => {
  const f = await setup(), body = html();
  const p = await f.reader.product(url, signal(), undefined, undefined, f.archive);
  expect(f.remote.data.get(p.originalHtml!.objectKey)).toEqual(body);
  const receipt = JSON.parse(Buffer.from(f.remote.data.get(f.archive.prefix + '/original.json')!).toString());
  expect(receipt.capturedAt).toBe(p.capturedAt); expect(receipt.source).toEqual(p.originalHtml);
  const cold = new AmazonHtmlArchive(new RetainedPublication(new AmazonMemory(), f.remote), f.job);
  expect(await f.reader.archivedProduct(url, signal(), cold)).toEqual(p);
  expect(await f.reader.product(url, signal(), undefined, undefined, cold)).toEqual(p);
  expect(f.get).toHaveBeenCalledOnce();
});
it.each(['<html>Robot Check</html>', '<html><body>Unexpected product template</body></html>'])('retains a completed HTML body even when product parsing fails: %s', async body => {
  const f = await setup(Buffer.from(body));
  await expect(f.reader.product(url, signal(), undefined, undefined, f.archive)).rejects.toThrow();
  expect(Buffer.from((await f.archive.inspect(signal()))!.bytes).toString()).toBe(body);
  await expect(f.reader.archivedProduct(url, signal(), f.archive)).rejects.toThrow();
  expect(f.get).toHaveBeenCalledOnce();
});
it('a failed R2 publication prevents parsing/retention and never triggers a second download', async () => {
  const f = await setup(), retain = vi.fn();
  const create = f.remote.create.bind(f.remote);
  vi.spyOn(f.remote, 'create').mockImplementation(async (key, ...rest) => {
    if (key.endsWith('/original.html')) throw Error('offline');
    return create(key, ...rest);
  });
  await expect(f.reader.product(url, signal(), retain, undefined, f.archive)).rejects.toThrow();
  expect(retain).not.toHaveBeenCalled(); expect(f.get).toHaveBeenCalledOnce();
  expect(await f.reader.archivedProduct(url, signal(), f.archive)).toBeNull();
  await expect(f.reader.product(url, signal(), retain, undefined, f.archive)).rejects.toThrow('HTML_DOWNLOAD_UNRESOLVED');
  expect(f.get).toHaveBeenCalledOnce();
});
it('rejects corrupt archived bytes instead of silently recapturing', async () => {
  const f = await setup(), saved = await f.archive.save(html(), signal());
  f.remote.data.set(saved.source.objectKey, Buffer.from('corrupt'));
  await expect(f.reader.product(url, signal(), undefined, undefined, f.archive)).rejects.toThrow();
  expect(f.get).not.toHaveBeenCalled();
});
it('an unfinished capture can resume only through its explicit archive-only port', async () => {
  const f = amazonFixture(), job = await f.job(), archive = new AmazonHtmlArchive(f.publication, job);
  const capture = vi.fn(async () => { await archive.save(Buffer.from('<html>retained</html>'), signal()); throw Error('parse-failed'); });
  const restore = vi.fn(async () => { const saved = await archive.inspect(signal()); return { ...f.product, originalHtml: saved!.source }; });
  const live = new AmazonLiveProduct(f.publication, f.settings, { capture, restore });
  await expect(live.capture(job, signal())).rejects.toThrow('parse-failed');
  expect(await live.capture(job, signal())).toHaveProperty('sourcePlan');
  expect(capture).toHaveBeenCalledOnce(); expect(restore).toHaveBeenCalledOnce();
});
