import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { ScraperApiTransport, type HttpRoute, type Response } from '@crawl-automation/v3-acquisition';
import { AmazonHtmlArchive, type AmazonHtmlFetchGate } from './amazon-html-archive.js';
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
  const gate: AmazonHtmlFetchGate = { acquire: vi.fn(async () => ({ kind: 'download' as const })), complete: vi.fn(async () => {}) };
  return { ...f, job, get, route, gate, reader: new AmazonHttpReader(route, undefined, gate), archive: new AmazonHtmlArchive(f.publication, job) };
}
it('requires an archive before making any provider call', async () => {
  const f = await setup();
  await expect(f.reader.product(url, signal())).rejects.toThrow('HTML_ARCHIVE_REQUIRED');
  expect(f.get).not.toHaveBeenCalled();
});
it('requires shared admission before a new download, even with an archive', async () => {
  const f = await setup();
  await expect(new AmazonHttpReader(f.route).product(url, signal(), undefined, undefined, f.archive)).rejects.toThrow('HTML_FETCH_GATE_REQUIRED');
  expect(f.get).not.toHaveBeenCalled();
});
it('reuses another task’s original, preserving capture time, origin proof and current ownership', async () => {
  const f = await setup(), original = await f.reader.product(url, signal(), undefined, undefined, f.archive);
  const oldReceipt = f.remote.data.get(`${f.archive.prefix}/original.json`);
  const job = structuredClone(f.job); job.operationId += '-new'; job.sessionId += '-new'; job.discovery.discoveryId += '-new';
  const archive = new AmazonHtmlArchive(f.publication, job);
  vi.mocked(f.gate.acquire).mockResolvedValue({ kind: 'reuse', job: f.job });
  const reused = await f.reader.product(url, signal(), undefined, undefined, archive);
  expect(reused.capturedAt).toBe(original.capturedAt); expect(reused.fetchedVia).toEqual(original.fetchedVia);
  expect(reused.originalHtml!.sha256).toBe(original.originalHtml!.sha256);
  expect(reused.originalHtml!.observationId).not.toBe(original.originalHtml!.observationId);
  expect(f.remote.data.get(`${f.archive.prefix}/original.json`)).toEqual(oldReceipt);
  const receipt = JSON.parse(Buffer.from(f.remote.data.get(`${archive.prefix}/original.json`)!).toString());
  expect(receipt.reusedFrom.receiptKey).toBe(`${f.archive.prefix}/original.json`);
  expect(f.gate.complete).toHaveBeenLastCalledWith(f.job, original.capturedAt, expect.any(AbortSignal));
  expect(f.get).toHaveBeenCalledOnce();
  f.remote.data.set(original.originalHtml!.objectKey, Buffer.from('corrupt origin'));
  await expect(archive.inspect(signal())).rejects.toThrow();
  expect(f.get).toHaveBeenCalledOnce();
});
it('a failed provider request blocks a different task without another GET or resource wait', async () => {
  const f = await setup(); f.get.mockRejectedValue(Error('network timeout'));
  await expect(f.reader.product(url, signal(), undefined, undefined, f.archive)).rejects.toThrow();
  const job = structuredClone(f.job); job.operationId += '-later'; job.sessionId += '-later';
  vi.mocked(f.gate.acquire).mockResolvedValue({ kind: 'reuse', job: f.job });
  await expect(f.reader.product(url, signal(), undefined, undefined, new AmazonHtmlArchive(f.publication, job))).rejects.toThrow('RECENT_HTML_FETCH_UNRESOLVED');
  expect(f.get).toHaveBeenCalledOnce(); expect(f.gate.complete).not.toHaveBeenCalled();
});
it('parse failure still leaves reusable HTML and never causes another paid fetch', async () => {
  const f = await setup(Buffer.from('<html>Robot Check</html>'));
  await expect(f.reader.product(url, signal(), undefined, undefined, f.archive)).rejects.toThrow('ACCESS_CHALLENGE');
  const job = structuredClone(f.job); job.operationId += '-parse-new'; job.sessionId += '-parse-new';
  vi.mocked(f.gate.acquire).mockResolvedValue({ kind: 'reuse', job: f.job });
  const next = new AmazonHtmlArchive(f.publication, job);
  await expect(f.reader.product(url, signal(), undefined, undefined, next)).rejects.toThrow('ACCESS_CHALLENGE');
  expect((await next.inspect(signal()))!.capturedAt).toBe((await f.archive.inspect(signal()))!.capturedAt);
  expect(f.get).toHaveBeenCalledOnce();
});
it('a database acknowledgment failure never re-downloads, and another task can reconcile the archive', async () => {
  const f = await setup(); vi.mocked(f.gate.complete).mockRejectedValueOnce(Error('DB unavailable'));
  await expect(f.reader.product(url, signal(), undefined, undefined, f.archive)).rejects.toThrow('DB unavailable');
  const job = structuredClone(f.job); job.operationId += '-reconcile'; job.sessionId += '-reconcile';
  vi.mocked(f.gate.acquire).mockResolvedValue({ kind: 'reuse', job: f.job });
  const next = await f.reader.product(url, signal(), undefined, undefined, new AmazonHtmlArchive(f.publication, job));
  expect(next.capturedAt).toBe((await f.archive.inspect(signal()))!.capturedAt);
  expect(f.get).toHaveBeenCalledOnce();
});
it('a paused or delayed executor cannot spend a stale download admission', async () => {
  const f = await setup();
  vi.mocked(f.gate.acquire).mockImplementation(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date().getTime() + 6000);
    return {kind:'download'};
  });
  try { await expect(f.reader.product(url,signal(),undefined,undefined,f.archive)).rejects.toThrow('HTML_ADMISSION_EXPIRED'); }
  finally { vi.restoreAllMocks(); }
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
it('archives UTF-8 BOM bytes unchanged before decoding', async () => {
  const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), html()]), f = await setup(body);
  const p = await f.reader.product(url, signal(), undefined, undefined, f.archive);
  expect(f.remote.data.get(p.originalHtml!.objectKey)).toEqual(body);
  expect(p.originalHtml!.byteSize).toBe(body.length);
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
