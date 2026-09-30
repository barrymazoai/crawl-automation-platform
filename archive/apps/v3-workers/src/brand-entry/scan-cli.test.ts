import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('./scan-cli.mjs', import.meta.url));
const brand = (id: string) => `https://www.amazon.com/s?k=Brand${id}&i=hpc&rh=n%3A3760901%2Cp_123%3A${id}&dc=`;
const asin = (b: string, n: number) => `B0${b.padStart(4, '0')}${String(n).padStart(4, '0')}`;
// One synthetic result page: 3 organic cards + 1 sponsored card, a carousel, and an optional next link.
function page(id: string, n: number, opts: { next: boolean; checked?: boolean; repeat?: boolean }) {
  const items = [1, 2, 3].map(i => asin(id, opts.repeat ? i : (n - 1) * 3 + i));
  return `<ul><li id="p_123/${id}"><a class="s-navigation-item"><input type="checkbox" ${opts.checked === false ? '' : 'checked'}>Brand</a></li></ul>` +
    `<div data-component-type="s-result-info-bar">1-3 of 9 results</div><div class="s-main-slot">` +
    items.map(a => `<div data-component-type="s-search-result" data-asin="${a}"><h2>x</h2></div>`).join('') +
    `<div data-component-type="s-search-result" data-asin="B0SPONSOR1"><span class="puis-sponsored-label-text">Sponsored</span></div></div>` +
    `<div data-asin="B0CAROUSE1"></div><span class="s-pagination-item s-pagination-selected">${n}</span>` +
    (opts.next ? `<a class="s-pagination-item s-pagination-next" href="/s?page=${n + 1}&amp;qid=1">Next</a>` : '');
}
// Brand 1001: 3 pages, then end. 1002: always has a next page (capped at maxPages=2). 1003: filter dropped on page 2.
// 1004: Amazon repeats page 1 as page 2 (no new products) -> end of list.
function respond(url: URL) {
  const id = url.searchParams.get('rh')!.split('%3A').pop()!.split(':').pop()!, n = Number(url.searchParams.get('page') ?? 1);
  if (url.searchParams.get('s') !== 'date-desc-rank') return '';
  if (id === '1001') return page(id, n, { next: n < 3 });
  if (id === '1002') return page(id, n, { next: true });
  if (id === '1003') return page(id, n, { next: true, checked: n === 1 });
  if (id === '1004') return page(id, n, { next: true, repeat: true });
  return '';
}

describe('brand scan runner', () => {
  it('walks pages newest first, archives every page, stops at the end, the page cap, a lost filter or a repeat', async () => {
    const dir = await fs.mkdtemp(join(os.tmpdir(), 'brand-scan-'));
    const seen: string[] = [];
    const server: Server = createServer((req, res) => {
      const target = new URL(new URL(req.url!, 'http://x').searchParams.get('url')!);
      seen.push(target.href);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'sa-credit-cost': '5' }); res.end(respond(target));
    });
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
    const port = (server.address() as { port: number }).port;
    try {
      const ids = ['1001', '1002', '1003', '1004'].map((b, i) => ({ id: `0000000${i}-0000-4000-8000-000000000000`, url: brand(b), b }));
      await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify({ codec: 'amazon-brand-scan/1', concurrency: 2, maxPages: 2, candidates: ids.map(({ id, url }) => ({ id, url })) }));
      await fs.writeFile(join(dir, 'key'), `http://127.0.0.1:${port}/capture`);
      await run(process.execPath, [cli, 'run', dir, join(dir, 'key')]);
      const result = async (i: number) => JSON.parse(await fs.readFile(join(dir, 'results', ids[i]!.id + '.json'), 'utf8'));

      // 1001 has 3 pages but maxPages=2: capped after page 2 with 6 products.
      const a = await result(0);
      expect(a.state).toBe('capped'); expect(a.code).toBe('BRAND_SCAN.PAGE_LIMIT');
      expect(a.asins).toEqual([1, 2, 3, 4, 5, 6].map(n => asin('1001', n)));
      expect(a.pages.map((p: { sponsored: number }) => p.sponsored)).toEqual([1, 1]);
      expect(a.asins).not.toContain('B0CAROUSE1');
      expect((await result(1)).state).toBe('capped');
      const c = await result(2);
      expect(c.state).toBe('review'); expect(c.code).toBe('BRAND_SEARCH.FILTER_LOST'); expect(c.asins).toHaveLength(3);
      const d = await result(3);
      expect(d.state).toBe('complete'); expect(d.catalogEnumerationComplete).toBe(false); expect(d.asins).toHaveLength(3);

      // Every requested page is newest-first, and every fetched page is archived and verifiable.
      expect(seen.every(u => new URL(u).searchParams.get('s') === 'date-desc-rank')).toBe(true);
      expect(seen).toHaveLength(8);
      for (const r of [a, c, d]) for (const p of r.pages) {
        const receipt = JSON.parse(await fs.readFile(join(dir, 'evidence', `${(await import('node:crypto')).createHash('sha256').update(p.url).digest('hex')}.json`), 'utf8'));
        expect(receipt.sha256).toBe(p.sha256); expect(receipt.archiveReadbackVerified).toBe(true);
      }
      const progress = JSON.parse(await fs.readFile(join(dir, 'progress.json'), 'utf8'));
      expect(progress).toMatchObject({ state: 'completed', complete: 4, capped: 2, full: 1, review: 1, submittedRequests: 8, credits: 40, databaseImported: false });

      // A rerun reuses results and archives: no new requests.
      await run(process.execPath, [cli, 'run', dir, join(dir, 'key')]);
      expect(seen).toHaveLength(8);
    } finally { server.close(); await fs.rm(dir, { recursive: true, force: true }); }
  }, 30000);

  it('scans GNC brand pages (200 per page) and proves completeness from the stated total', async () => {
    const dir = await fs.mkdtemp(join(os.tmpdir(), 'brand-scan-gnc-'));
    const gncTile = (sku: string) => `<li class="grid-tile"><div class="product-tile" data-itemid="${sku}"><a href="https://www.gnc.com/protein/${sku}.html">P</a></div></li>`;
    const gncPage = (skus: string[], total: number, next: number | null) => `<html><body><input class="product-custom-count" data-actual-productcount="${total}.0"/>` +
      `<ul class="search-result-items">${skus.map(gncTile).join('')}</ul>` +
      (next === null ? '' : `<div class="load-more-products" data-grid-url="/brands/big/?srule=new-arrivals&amp;start=${next}&amp;sz=200"></div>`) + '</body></html>';
    const seen: string[] = [];
    const server: Server = createServer((req, res) => {
      const target = new URL(new URL(req.url!, 'http://x').searchParams.get('url')!); seen.push(target.href);
      const start = Number(target.searchParams.get('start'));
      const body = target.pathname === '/brands/small/' ? gncPage(['100001', '100002', '100001'], 3, null)
        : start === 0 ? gncPage(['200001', '200002'], 3, 200) : gncPage(['200003'], 3, null);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'sa-credit-cost': '10' }); res.end(body);
    });
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
    try {
      const ids = [{ id: '10000000-0000-4000-8000-000000000000', url: 'https://www.gnc.com/brands/small/' }, { id: '20000000-0000-4000-8000-000000000000', url: 'https://www.gnc.com/brands/big/' }];
      await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify({ codec: 'gnc-brand-scan/1', concurrency: 2, maxPages: 5, candidates: ids }));
      await fs.writeFile(join(dir, 'key'), `http://127.0.0.1:${(server.address() as { port: number }).port}/capture`);
      await run(process.execPath, [cli, 'run', dir, join(dir, 'key')]);
      const small = JSON.parse(await fs.readFile(join(dir, 'results', ids[0]!.id + '.json'), 'utf8'));
      expect(small).toMatchObject({ codec: 'gnc-brand-scan-result/1', state: 'complete', ids: ['100001', '100002'], totalResults: 3, catalogEnumerationComplete: true, sort: 'new-arrivals' });
      expect(small.items['100001']).toBe('https://www.gnc.com/protein/100001.html');
      const big = JSON.parse(await fs.readFile(join(dir, 'results', ids[1]!.id + '.json'), 'utf8'));
      expect(big).toMatchObject({ state: 'complete', ids: ['200001', '200002', '200003'], catalogEnumerationComplete: true });
      expect(seen.every(u => u.includes('srule=new-arrivals') && u.includes('sz=200'))).toBe(true);
      expect(seen).toHaveLength(3);
    } finally { server.close(); await fs.rm(dir, { recursive: true, force: true }); }
  }, 30000);

  it('scans Swanson brands through products.json (JSON evidence) and orders products newest first', async () => {
    const dir = await fs.mkdtemp(join(os.tmpdir(), 'brand-scan-swanson-'));
    const product = (id: number, published: string) => ({ id, handle: `p-${id}`, title: 'T', vendor: 'Brand', published_at: published, created_at: published,
      variants: [{ id: id + 1, sku: `S${id}`, available: true, price: '9.99', title: 'Default Title' }] });
    const seen: string[] = [];
    const server: Server = createServer((req, res) => {
      const target = new URL(new URL(req.url!, 'http://x').searchParams.get('url')!); seen.push(target.href);
      const page = Number(target.searchParams.get('page'));
      // 251 products: page 1 is full (250), page 2 has one more.
      const products = page === 1 ? Array.from({ length: 250 }, (_, i) => product(1000000 + i, `2024-01-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00Z`)) : [product(2000000, '2026-09-01T00:00:00Z')];
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'sa-credit-cost': '1' }); res.end(JSON.stringify({ products }));
    });
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
    try {
      const id = '30000000-0000-4000-8000-000000000000';
      await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify({ codec: 'swanson-brand-scan/1', concurrency: 1, maxPages: 5,
        candidates: [{ id, url: 'https://www.swansonvitamins.com/collections/brand-healthy-origins' }] }));
      await fs.writeFile(join(dir, 'key'), `http://127.0.0.1:${(server.address() as { port: number }).port}/capture`);
      await run(process.execPath, [cli, 'run', dir, join(dir, 'key')]);
      const r = JSON.parse(await fs.readFile(join(dir, 'results', id + '.json'), 'utf8'));
      expect(r).toMatchObject({ codec: 'swanson-brand-scan-result/1', state: 'complete', catalogEnumerationComplete: true, sort: 'published_at-desc' });
      expect(r.ids).toHaveLength(251); expect(r.ids[0]).toBe('2000000');
      expect(r.items['2000000']).toMatchObject({ url: 'https://www.swansonvitamins.com/p/p-2000000', variants: [{ id: '2000001', sku: 'S2000000', available: true }] });
      expect(seen).toEqual(['https://www.swansonvitamins.com/collections/brand-healthy-origins/products.json?limit=250&page=1',
        'https://www.swansonvitamins.com/collections/brand-healthy-origins/products.json?limit=250&page=2']);
    } finally { server.close(); await fs.rm(dir, { recursive: true, force: true }); }
  }, 30000);

  it('rejects a manifest with a non-scan URL or a duplicate id', async () => {
    const dir = await fs.mkdtemp(join(os.tmpdir(), 'brand-scan-'));
    try {
      const bad = async (candidates: unknown[]) => {
        await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify({ codec: 'amazon-brand-scan/1', concurrency: 1, maxPages: 2, candidates }));
        await expect(run(process.execPath, [cli, 'status', dir])).rejects.toThrow();
      };
      const id = '00000000-0000-4000-8000-000000000000';
      await bad([{ id, url: 'https://www.amazon.com/s?k=a&i=hpc' }]);
      await bad([{ id, url: brand('1') }, { id, url: brand('2') }]);
      await bad([{ id, url: brand('1') + '&page=2' }]);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
