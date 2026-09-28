// Brand scan: every product of each brand in the manifest, newest first, page by page.
// Sites: Amazon Brand-filter searches / brand pages (amazon-brand-scan/1), GNC brand pages (gnc-brand-scan/1) and
// Swanson brand collections through Shopify's products.json (swanson-brand-scan/1).
// Standalone and finite: no Temporal, R2, database or browser. Search pages only; product
// pages are never fetched here (the product queue does that under its own admission rules).
// Every response is archived byte-for-byte and read back before it is parsed; a page that was
// requested but has no verified archive stops that brand (no automatic repeat of a paid request).
//   node scan-cli.mjs run|status <run-dir> [key-file]
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { request as httpRequest } from 'node:http';
import { resolve, join } from 'node:path';
import { scanAddress, scanPageUrl, scanPage } from '../../../../packages/v3-channels/src/amazon-brand-search.mjs';
import { gncScanAddress, gncScanPageUrl, gncScanPage } from '../../../../packages/v3-channels/src/gnc-brand-scan.mjs';
import { swansonScanAddress, swansonScanPageUrl, swansonScanPage } from '../../../../packages/v3-channels/src/swanson-brand-scan.mjs';

// One profile per site. GNC pages state their total, so a GNC scan can prove it read every tile.
const profiles = {
  'amazon-brand-scan/1': { address: scanAddress, pageUrl: scanPageUrl, parse: scanPage, sort: 'date-desc-rank', result: 'amazon-brand-scan-result/1', ids: 'asins',
    complete: (p, pages) => p.nextPage === null },
  'gnc-brand-scan/1': { address: gncScanAddress, pageUrl: gncScanPageUrl, parse: gncScanPage, sort: 'new-arrivals', result: 'gnc-brand-scan-result/1', ids: 'ids',
    complete: (p, pages) => p.nextPage === null && p.totalResults !== null && pages.reduce((n, x) => n + x.cards, 0) === p.totalResults },
  // Shopify pages hold 250 products; a shorter page is the end of the collection.
  'swanson-brand-scan/1': { address: swansonScanAddress, pageUrl: swansonScanPageUrl, parse: swansonScanPage, sort: 'published_at-desc', result: 'swanson-brand-scan-result/1', ids: 'ids',
    contentType: /^application\/json\b/i, complete: (p) => p.nextPage === null },
};

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const exists = async p => { try { await fs.access(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const save = async (p, value) => {
  const h = await fs.open(p, 'wx', 0o600);
  try { await h.writeFile(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2)); await h.sync(); } finally { await h.close(); }
};
const atomic = async (p, value) => { const t = p + '.' + randomUUID(); await save(t, value); await fs.rename(t, p); };
const code = e => /^BRAND_(SEARCH|SCAN)\.[A-Z_]+$/.test(e?.message ?? '') ? e.message : 'BRAND_SCAN.LOCAL_OR_EXECUTION_UNKNOWN';
const [command, rootArg, keyFile] = process.argv.slice(2), root = resolve(rootArg ?? '.');
if (!['run', 'status'].includes(command)) throw Error('Usage: scan-cli.mjs run|status <run-dir> [private-key-file]');
const manifest = await read(join(root, 'manifest.json'));
const profile = profiles[manifest.codec];
if (!profile || !(Number.isInteger(manifest.concurrency) && manifest.concurrency >= 1 && manifest.concurrency <= 50) ||
    !(Number.isInteger(manifest.maxPages) && manifest.maxPages >= 1 && manifest.maxPages <= 50) ||
    !Array.isArray(manifest.candidates) || !manifest.candidates.length || manifest.candidates.length > 2000) throw Error('BRAND_SCAN.MANIFEST');
const ids = new Set();
for (const c of manifest.candidates) {
  if (!/^[a-f0-9-]{36}$/.test(c?.id ?? '') || ids.has(c.id) || profile.address(c.url).page !== 1) throw Error('BRAND_SCAN.MANIFEST');
  ids.add(c.id);
}
const limit = manifest.concurrency, maxPages = manifest.maxPages;
if (command === 'status') {
  const progress = await read(join(root, 'progress.json')).catch(() => null);
  console.log(JSON.stringify({ manifest: { candidates: manifest.candidates.length, concurrency: limit, maxPages }, progress }));
} else {
  const key = (await fs.readFile(keyFile, 'utf8')).trim();
  // The production broker on Server 一 keeps the ScraperAPI key; a loopback broker is accepted for tests.
  const broker = key === 'http://100.76.126.12:19419/capture' || /^http:\/\/127\.0\.0\.1:\d{2,5}\/capture$/.test(key) ? key : null;
  if (!broker && !/^[A-Za-z0-9_-]{8,512}$/.test(key)) throw Error('BRAND_SCAN.CREDENTIAL');
  for (const part of ['results', 'attempts', 'evidence']) await fs.mkdir(join(root, part), { recursive: true, mode: 0o700 });
  // A leftover lock requires operator reconciliation, not automatic resume over a surviving process.
  const lock = await fs.open(join(root, 'run-lock.json'), 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); await lock.sync();
  let halt = false, fatal = null, challenges = 0, active = 0, peak = 0, cursor = 0, complete = 0, full = 0, capped = 0, review = 0, pages = 0, products = 0, requests = 0, credits = 0;
  const startedAt = new Date().toISOString();
  process.once('SIGTERM', () => { halt = true; }); process.once('SIGINT', () => { halt = true; });
  let publishing = Promise.resolve();
  const publish = state => {
    const progress = { at: new Date().toISOString(), startedAt, pid: process.pid, state, fatal, total: manifest.candidates.length,
      complete, full, capped, review, remaining: manifest.candidates.length - complete, pages, products, activeRequests: active, peakRequests: peak,
      submittedRequests: requests, credits, concurrencyLimit: limit, maxPages, databaseImported: false };
    publishing = publishing.then(() => atomic(join(root, 'progress.json'), progress)); return publishing;
  };
  const timer = setInterval(() => { publish(halt ? 'draining' : 'running').catch(() => { halt = true; fatal = 'BRAND_SCAN.PROGRESS_WRITE'; }); }, 5000);
  async function capture(url) {
    url = profile.address(url).url;
    const stem = join(root, 'evidence', hash(url)), receiptPath = stem + '.json';
    if (await exists(receiptPath)) {
      const r = await read(receiptPath), b = await fs.readFile(stem + '.html');
      if (r.url !== url || hash(b) !== r.sha256 || b.length !== r.byteSize || r.status !== 200) throw Error('BRAND_SCAN.ARCHIVE_UNVERIFIED');
      return { receipt: r, html: b.toString('utf8') };
    }
    if (halt) throw Error('BRAND_SCAN.BATCH_STOPPED');
    // Survives unknown network outcomes and prevents repeat charges for the same page.
    if (await exists(stem + '.intent.json')) throw Error('BRAND_SCAN.PRIOR_ATTEMPT_UNRESOLVED');
    const start = Date.now(); await save(stem + '.intent.json', { url, at: new Date().toISOString(), attempts: 1 });
    const endpoint = new URL(broker ?? 'https://api.scraperapi.com/');
    for (const [k, v] of Object.entries(broker ? { url } : { api_key: key, country_code: 'us', follow_redirect: 'false', url })) endpoint.searchParams.set(k, v);
    active++; requests++; peak = Math.max(peak, active);
    try {
      if (active > limit) throw Error('BRAND_SCAN.CONCURRENCY');
      const result = await new Promise((ok, bad) => {
        const req = (broker ? httpRequest : request)(endpoint, { agent: false, signal: AbortSignal.timeout(broker ? 105000 : 90000), headers: { accept: 'text/html', 'accept-encoding': 'identity' } }, res => {
          let size = 0; const chunks = [];
          res.on('data', b => { size += b.length; if (size > 6 * 1024 * 1024) req.destroy(); else chunks.push(b); });
          res.on('error', () => bad(Error('BRAND_SCAN.RESPONSE_INCOMPLETE')));
          res.on('end', () => ok({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
        });
        req.on('error', () => bad(Error('BRAND_SCAN.EXECUTION_UNKNOWN'))); req.end();
      });
      await save(stem + '.html', result.bytes);
      const bytes = await fs.readFile(stem + '.html');
      if (hash(bytes) !== hash(result.bytes)) throw Error('BRAND_SCAN.ARCHIVE_UNVERIFIED');
      const charged = Number(result.headers['sa-credit-cost'] ?? 0); if (Number.isFinite(charged)) credits += charged;
      const receipt = { url, capturedAt: new Date().toISOString(), elapsedMs: Date.now() - start, status: result.status,
        byteSize: bytes.length, sha256: hash(bytes), credits: Number.isFinite(charged) ? charged : null,
        contentType: result.headers['content-type'] ?? null, encoding: result.headers['content-encoding'] ?? null,
        archiveReadbackVerified: true, applicationAttempts: 1 };
      await save(receiptPath, receipt);
      if ([401, 403, 429].includes(result.status)) { halt = true; fatal = 'BRAND_SCAN.PROVIDER_ADMISSION'; }
      if (result.status !== 200) throw Error('BRAND_SCAN.HTTP_STATUS');
      if (!(profile.contentType ?? /^text\/html\b/i).test(String(receipt.contentType)) || receipt.encoding && receipt.encoding !== 'identity') throw Error('BRAND_SCAN.CONTENT_TYPE');
      if (result.headers['sa-final-url']) { let final = null; try { final = profile.address(result.headers['sa-final-url']).url; } catch {} if (final !== url) throw Error('BRAND_SCAN.REDIRECT'); }
      return { receipt, html: bytes.toString('utf8') };
    } finally { active--; }
  }
  async function one(c) {
    const file = join(root, 'results', c.id + '.json');
    const tally = r => { complete++; r.state === 'complete' ? full++ : r.state === 'capped' ? capped++ : review++; pages += r.pages.length; products += (r.asins ?? r.ids).length; };
    if (await exists(file)) { tally(await read(file)); return; }
    const intent = join(root, 'attempts', c.id + '.json');
    const base = profile.address(c.url).url, asins = [], seen = new Set(), items = {}, kinds = {};
    const out = { codec: profile.result, id: c.id, url: base, sort: profile.sort, state: 'review', code: null,
      maxPages, pages: [], [profile.ids]: asins, totalResults: null, catalogEnumerationComplete: false, databaseImported: false };
    if (profile.ids === 'ids') { out.items = items; out.kinds = kinds; }
    try {
      if (await exists(intent)) throw Error('BRAND_SCAN.PRIOR_ATTEMPT_UNRESOLVED');
      await save(intent, { at: new Date().toISOString(), id: c.id });
      for (let n = 1; ; n++) {
        const got = await capture(profile.pageUrl(base, n));
        const p = profile.parse(got.html, got.receipt.url);
        const fresh = p.organic.filter(a => !seen.has(a)); for (const a of fresh) { seen.add(a); asins.push(a); if (p.items) items[a] = p.items[a]; if (p.kinds) kinds[a] = p.kinds[a]; }
        out.pages.push({ page: n, url: got.receipt.url, sha256: got.receipt.sha256, byteSize: got.receipt.byteSize, capturedAt: got.receipt.capturedAt,
          organic: p.organic.length, newOnPage: fresh.length, sponsored: p.sponsored, cards: p.cards, ...(p.promotions ? { promotions: p.promotions } : {}), nextPage: p.nextPage, totalResults: p.totalResults, brandFilterSelected: p.brandFilterSelected });
        if (n === 1) out.totalResults = p.totalResults;
        // End of list: no next page, or a page that adds nothing new (Amazon repeats the last page past the end).
        if (p.nextPage === null || !p.organic.length || !fresh.length) { out.state = 'complete'; out.catalogEnumerationComplete = profile.complete(p, out.pages); break; }
        if (n >= maxPages) { out.state = 'capped'; out.code = 'BRAND_SCAN.PAGE_LIMIT'; break; }
      }
    } catch (e) {
      out.code = code(e);
      // A paid page that turns out to be a challenge is kept; repeated challenges stop the run instead of paying for more.
      if (out.code.endsWith('.ACCESS_CHALLENGE') && ++challenges >= 3) { halt = true; fatal = 'BRAND_SCAN.REPEATED_ACCESS_CHALLENGE'; }
    }
    if (profile.sort === 'published_at-desc') asins.sort((x, y) => String(items[y]?.publishedAt ?? '').localeCompare(String(items[x]?.publishedAt ?? '')));
    await save(file, out); tally(out);
    console.log(JSON.stringify({ id: c.id, state: out.state, code: out.code, pages: out.pages.length, products: asins.length, complete }));
  }
  try {
    await publish('running');
    await Promise.all(Array.from({ length: limit }, async () => {
      try { while (!halt) { const c = manifest.candidates[cursor++]; if (!c) break; await one(c); } }
      catch (e) { halt = true; fatal = code(e); process.exitCode = 1; }
    }));
  } catch (e) { halt = true; fatal = code(e); process.exitCode = 1; }
  finally {
    clearInterval(timer);
    await publish(halt ? 'paused' : 'completed'); await lock.close(); await fs.unlink(join(root, 'run-lock.json'));
  }
}
