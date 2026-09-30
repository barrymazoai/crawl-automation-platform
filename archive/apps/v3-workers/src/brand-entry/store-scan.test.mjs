import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { crawlStore } from './store-scan-core.mjs';
import { scanStore, recover } from './store-scan-browser.mjs';

const sha = s => createHash('sha256').update(s).digest('hex');
const id = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`.toUpperCase();
const store = n => `https://www.amazon.com/stores/Brand/page/${id(n)}`;
const tile = a => `<li><div data-asin="${a}"><a href="/dp/${a}">x</a></div></li>`;
// A small store: home -> 2 tabs; tab 2 -> Shop All (keyless); a link to another brand's store is ignored.
const site = {
  [store(1)]: `<title>Amazon.com: Brand</title><a href="/stores/Brand/page/${id(2)}?ref=nav">Vitamins</a><a href="/stores/Brand/page/${id(3)}">Herbs</a><a href="/stores/Other/page/${id(9)}">Other</a>${tile('B000000001')}${tile('B000000002')}`,
  [store(2)]: `<title>Amazon.com: Brand: Vitamins</title><a href="/stores/page/${id(4)}">Shop All</a>${tile('B000000002')}${tile('B000000003')}`,
  [store(3)]: `<title>Amazon.com: Brand: Herbs</title>${tile('B000000004')}<li><div data-asin="B0SPONSOR1"><span>Sponsored</span></div></li>`,
  [`https://www.amazon.com/stores/page/${id(4)}`]: `<title>Amazon.com: Brand: Shop All</title>${[1, 2, 3, 4, 5].map(n => tile('B00000000' + n)).join('')}<a href="/s?srs=77&rh=x">See more</a>`,
};
const memoryRetain = () => async (url, html) => ({ url, sha256: sha(html), byteSize: Buffer.byteLength(html), capturedAt: '2026-09-28T00:00:00.000Z', html });

describe('store crawl core', () => {
  it('reads every page of the same store once, merges products, skips sponsored and other stores', async () => {
    const loaded = [];
    const r = await crawlStore({ id: 'x', url: store(1) + '?ingress=0', maxPages: 10, deadline: Date.now() + 60000,
      load: async u => { loaded.push(u); return { finalUrl: u, html: site[u] }; }, retain: memoryRetain() });
    expect(r.state).toBe('complete'); expect(r.code).toBe(null);
    expect(r.asins).toEqual(['B000000001', 'B000000002', 'B000000003', 'B000000004', 'B000000005']);
    expect(loaded).toEqual([store(1), store(2), store(3), `https://www.amazon.com/stores/page/${id(4)}`]);
    expect(r.pages.map(p => p.newOnPage)).toEqual([2, 1, 1, 1]);
    expect(r.pages[2].sponsored).toBe(1);
    expect(r.shopAll).toBe(true); expect(r.srsLinks).toEqual([{ url: 'https://www.amazon.com/s?srs=77', text: 'See more' }]);
    expect(r.catalogEnumerationComplete).toBe(false);
  });
  it('stops at the page cap, a gone store, a challenge or the time limit', async () => {
    const load = async u => ({ finalUrl: u, html: site[u] });
    const capped = await crawlStore({ id: 'x', url: store(1), maxPages: 2, deadline: Date.now() + 60000, load, retain: memoryRetain() });
    expect(capped.state).toBe('capped'); expect(capped.code).toBe('STORE_SCAN.PAGE_LIMIT'); expect(capped.unvisited).toBe(2);
    const gone = await crawlStore({ id: 'x', url: store(1), maxPages: 5, deadline: Date.now() + 60000, load: async () => ({ finalUrl: 'https://www.amazon.com/', html: '' }), retain: memoryRetain() });
    expect(gone.code).toBe('STORE_SCAN.STORE_GONE');
    const challenge = await crawlStore({ id: 'x', url: store(1), maxPages: 5, deadline: Date.now() + 60000, load: async u => ({ finalUrl: u, html: 'Enter the characters you see below' }), retain: memoryRetain() });
    expect(challenge.code).toBe('STORE_SCAN.ACCESS_CHALLENGE');
    let t = 0; const late = await crawlStore({ id: 'x', url: store(1), maxPages: 5, deadline: 1, now: () => (t += 1), load, retain: memoryRetain() });
    expect(late.code).toBe('STORE_SCAN.TIME_LIMIT');
    const control = await crawlStore({ id: 'x', url: store(1), maxPages: 5, deadline: Date.now() + 60000, load: async () => { throw Error('The user has taken control of this task space'); }, retain: memoryRetain() });
    expect(control.code).toBe('STORE_SCAN.USER_CONTROL');
  });
});

// A fake Ego TaskSpace: pages are tabs; evaluate() answers the two page scripts the browser module uses.
function fakeEgo({ ownership = 'agent', closeFails = false } = {}) {
  const tabs = [{ label: 'p0', targetId: 'user-tab', openedBy: 'unknown' }]; let n = 0;
  const task = {
    get ownership() { return ownership; }, set ownership(v) { ownership = v; },
    async tabs() { return tabs.map(t => ({ ...t })); },
    async newPage() {
      const label = `p${++n}`, targetId = `t${n}`; let current = 'about:blank';
      tabs.push({ label, targetId, openedBy: 'agent' });
      const page = { label,
        async goto(u) { current = u; }, async waitForFunction() {}, async waitForTimeout() {},
        async evaluate(fn) { return /outerHTML/.test(String(fn)) ? `<html>${site[current] ?? ''}</html>` : { h: 1, n: 1, clicked: false }; },
        async url() { return current; },
        async close() { if (!closeFails) tabs.splice(tabs.findIndex(t => t.targetId === targetId), 1); } };
      task._pages[label] = page; return page;
    },
    _pages: {}, page(label) { return this._pages[label]; },
  };
  return { api: { taskSpace: async () => task }, task, tabs };
}

describe('store scan in Ego (fake browser)', () => {
  it('opens one own page, archives every page before parsing, closes the page and leaves user tabs alone', async () => {
    const runRoot = await fs.mkdtemp(join(os.tmpdir(), 'store-scan-'));
    try {
      for (const d of ['journals', 'evidence']) await fs.mkdir(join(runRoot, d));
      const { api, tabs } = fakeEgo();
      const r = await scanStore(api, { runRoot, id: 'aaaa', url: store(1), maxPages: 10, taskSpaceId: 1, timeLimitMs: 60000 });
      expect(r.state).toBe('complete'); expect(r.asins).toHaveLength(5);
      expect(r.cleanup.status).toBe('closed');
      expect(tabs.map(t => t.targetId)).toEqual(['user-tab']);
      for (const p of r.pages) {
        const bytes = await fs.readFile(join(runRoot, 'evidence', sha(p.url) + '.html'));
        expect(sha(bytes)).toBe(p.sha256);
        expect(JSON.parse(await fs.readFile(join(runRoot, 'evidence', sha(p.url) + '.json'), 'utf8'))).toMatchObject({ representation: 'rendered-dom-after-load', archiveReadbackVerified: true });
      }
      const journal = JSON.parse(await fs.readFile(join(runRoot, 'journals', 'aaaa.json'), 'utf8'));
      expect(journal).toMatchObject({ phase: 'finished', owned: { label: 'p1', targetId: 't1' }, cleanup: { status: 'closed' } });
      // A second attempt for the same store is refused by its journal (no automatic rerun).
      await expect(scanStore(api, { runRoot, id: 'aaaa', url: store(1), maxPages: 10, taskSpaceId: 1, timeLimitMs: 60000 })).rejects.toThrow();
    } finally { await fs.rm(runRoot, { recursive: true, force: true }); }
  });
  it('reports a page it could not close as pending; recover closes it later; a user-owned space is not touched', async () => {
    const runRoot = await fs.mkdtemp(join(os.tmpdir(), 'store-scan-'));
    try {
      for (const d of ['journals', 'evidence']) await fs.mkdir(join(runRoot, d));
      const stuck = fakeEgo({ closeFails: true });
      const r = await scanStore(stuck.api, { runRoot, id: 'bbbb', url: store(3), maxPages: 1, taskSpaceId: 1, timeLimitMs: 60000 });
      expect(r.cleanup.status).toBe('pending');
      expect(stuck.tabs.map(t => t.targetId)).toEqual(['user-tab', 't1']);
      stuck.tabs.splice(1, 1); // the page closed later (e.g. the close receipt lagged)
      expect((await recover(stuck.api, { runRoot, id: 'bbbb', taskSpaceId: 1 })).status).toBe('closed');
      const user = fakeEgo({ ownership: 'user' });
      const u = await scanStore(user.api, { runRoot, id: 'cccc', url: store(1), maxPages: 10, taskSpaceId: 1, timeLimitMs: 60000 });
      expect(u.code).toBe('STORE_SCAN.USER_CONTROL'); expect(u.cleanup.status).toBe('not_opened'); expect(user.tabs).toHaveLength(1);
    } finally { await fs.rm(runRoot, { recursive: true, force: true }); }
  });
});
