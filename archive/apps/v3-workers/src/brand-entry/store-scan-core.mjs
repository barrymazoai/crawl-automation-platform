// One Amazon Brand Store, every page (up to maxPages), every product. Browser access is injected:
//   load(url)            -> { finalUrl, html }   the fully loaded page (scrolled, "show more" clicked)
//   retain(url, html)    -> { url, sha256, byteSize, capturedAt, html }   archived and read back before parsing
// A store cannot prove it lists every product, so catalogEnumerationComplete stays false; state 'complete' means
// every same-store page found was read within the page cap.
import { storeAddress, storePage, sameStore } from '../../../../packages/v3-channels/src/amazon-store-scan.mjs';

// Ego reports a user takeover or a browser-owned prompt as an error; that is a hard stop, never retried.
const code = e => /^(STORE_SCAN|BRAND_SCAN)\.[A-Z_]+$/.test(e?.message ?? '') ? e.message
  : /taken control|user now controls|user control|permission prompt|delegated to user/i.test(e?.message ?? '') ? 'STORE_SCAN.USER_CONTROL' : 'STORE_SCAN.EXECUTION_UNRESOLVED';
export async function crawlStore({ id, url, maxPages, deadline, load, retain, now = () => Date.now() }) {
  const home = storeAddress(url), key = home.key, asins = [], seen = new Set(), queued = new Set([home.pageId]), queue = [home.url];
  const out = { codec: 'amazon-brand-scan-result/1', id, kind: 'store', url: home.url, state: 'review', code: null, maxPages,
    pages: [], asins, shopAll: false, srsLinks: [], totalResults: null, catalogEnumerationComplete: false, databaseImported: false };
  const products = new Set(), srs = new Map();
  try {
    while (queue.length) {
      if (out.pages.length >= maxPages) { out.state = 'capped'; out.code = 'STORE_SCAN.PAGE_LIMIT'; out.unvisited = queue.length; return out; }
      if (now() > deadline) throw Error('STORE_SCAN.TIME_LIMIT');
      const next = queue.shift();
      const got = await load(next);
      let final;
      try { final = storeAddress(got.finalUrl); } catch { final = null; }
      // The store itself must still be a store page; a sub-page that now leads elsewhere is recorded and skipped.
      if (!final || !sameStore(final, key)) {
        if (!out.pages.length) throw Error('STORE_SCAN.STORE_GONE');
        out.pages.push({ page: out.pages.length + 1, url: next, redirectedTo: String(got.finalUrl).slice(0, 300), skipped: true, organic: 0, newOnPage: 0, sponsored: 0 });
        continue;
      }
      if (seen.has(final.pageId)) continue;
      seen.add(final.pageId); queued.add(final.pageId);
      const saved = await retain(final.url, got.html);
      const p = storePage(saved.html, final.url, key);
      const fresh = p.organic.filter(a => !products.has(a)); for (const a of fresh) { products.add(a); asins.push(a); }
      out.pages.push({ page: out.pages.length + 1, url: saved.url, sha256: saved.sha256, byteSize: saved.byteSize, capturedAt: saved.capturedAt,
        title: p.title, organic: p.organic.length, newOnPage: fresh.length, sponsored: p.sponsored.length, links: p.links.length });
      if (p.shopAll) out.shopAll = true;
      for (const s of p.srsLinks) srs.set(s.url, s.text);
      for (const l of p.links) { const a = storeAddress(l.url); if (!queued.has(a.pageId)) { queued.add(a.pageId); queue.push(a.url); } }
    }
    out.state = 'complete';
  } catch (e) { out.code = code(e); }
  finally { out.srsLinks = [...srs].map(([u, t]) => ({ url: u, text: t })).slice(0, 20); }
  return out;
}
