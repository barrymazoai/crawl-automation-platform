// Standalone finite search preparation. No Temporal, R2, database or browser. Product pages are fetched
// only in identity mode, through the broker's 24h admission check, to read the brand byline.
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { request as httpRequest } from 'node:http';
import { resolve, join } from 'node:path';
import { inspectSearch, normalizeBrand, searchAddress, productAddress, productByline, organicAsins } from '../../../../packages/v3-channels/src/amazon-brand-search.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const exists = async p => { try { await fs.access(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const save = async (p, value) => {
  const h = await fs.open(p, 'wx', 0o600);
  try { await h.writeFile(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2)); await h.sync(); } finally { await h.close(); }
};
const atomic = async (p, value) => { const t = p + '.' + randomUUID(); await save(t, value); await fs.rename(t, p); };
const code = e => /^BRAND_SEARCH\.[A-Z_]+$/.test(e?.message ?? '') ? e.message : 'BRAND_SEARCH.LOCAL_OR_EXECUTION_UNKNOWN';
const [command, rootArg, keyFile] = process.argv.slice(2), root = resolve(rootArg ?? '.');
if (!['run', 'status'].includes(command)) throw Error('Usage: search-cli.mjs run|status <run-dir> [private-key-file]');
const manifest = await read(join(root, 'manifest.json'));
if (manifest.codec !== 'amazon-brand-search/1' || manifest.concurrency !== 50 || !Array.isArray(manifest.candidates) || manifest.candidates.length > 2000) throw Error('BRAND_SEARCH.MANIFEST');
const names = c => [...new Set((c.names ?? []).filter(n => typeof n === 'string').map(n => n.normalize('NFKC').replace(/\s+/g, ' ').trim()).filter(n => n.length > 0 && n.length <= 80 && !/[\x00-\x1f]/.test(n)))];
if (command === 'status') {
  const progress = await read(join(root, 'progress.json')).catch(() => null);
  console.log(JSON.stringify({ manifest: { candidates: manifest.candidates.length, concurrency: manifest.concurrency }, progress }));
} else {
  const key = (await fs.readFile(keyFile, 'utf8')).trim();
  const broker = key === 'http://100.76.126.12:19419/capture' ? key : null;
  if (!broker && !/^[A-Za-z0-9_-]{8,512}$/.test(key)) throw Error('BRAND_SEARCH.CREDENTIAL');
  for (const part of ['results', 'attempts', 'evidence']) await fs.mkdir(join(root, part), { recursive: true, mode: 0o700 });
  // A leftover lock requires operator reconciliation, not automatic resume over a surviving process.
  const lock = await fs.open(join(root, 'run-lock.json'), 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); await lock.sync();
  let halt = false, fatal = null, active = 0, peak = 0, cursor = 0, complete = 0, verified = 0, review = 0, storeLinks = 0, requests = 0, credits = 0;
  const startedAt = new Date().toISOString();
  process.once('SIGTERM', () => { halt = true; }); process.once('SIGINT', () => { halt = true; });
  let publishing = Promise.resolve();
  const publish = state => {
    const progress = { at: new Date().toISOString(), startedAt, pid: process.pid, state, fatal, total: manifest.candidates.length,
      complete, verified, storeLinks, review, remaining: manifest.candidates.length - complete, activeRequests: active, peakRequests: peak,
      submittedRequests: requests, credits, concurrencyLimit: 50, databaseImported: false };
    publishing = publishing.then(() => atomic(join(root, 'progress.json'), progress)); return publishing;
  };
  const timer = setInterval(() => { publish(halt ? 'draining' : 'running').catch(() => { halt = true; fatal = 'BRAND_SEARCH.PROGRESS_WRITE'; }); }, 5000);
  const inflight = new Map();
  async function capture(url, product = false) {
    url = product ? productAddress(url).url : searchAddress(url);
    if (inflight.has(url)) return inflight.get(url);
    const work = (async () => {
      const stem = join(root, 'evidence', hash(url)), receiptPath = stem + '.json';
      if (await exists(receiptPath)) {
        const r = await read(receiptPath), b = await fs.readFile(stem + '.html');
        if (r.url !== url || hash(b) !== r.sha256 || b.length !== r.byteSize || r.status !== 200) throw Error('BRAND_SEARCH.ARCHIVE_UNVERIFIED');
        return { receipt: r, html: b.toString('utf8') };
      }
      if (halt) throw Error('BRAND_SEARCH.BATCH_STOPPED');
      // Survives unknown network outcomes and prevents repeat charges for the same search.
      if (await exists(stem + '.intent.json')) throw Error('BRAND_SEARCH.PRIOR_ATTEMPT_UNRESOLVED');
      const start = Date.now(); await save(stem + '.intent.json', { url, at: new Date().toISOString(), attempts: 1 });
      const endpoint = new URL(broker ?? 'https://api.scraperapi.com/');
      for (const [k, v] of Object.entries(broker ? { url } : { api_key: key, country_code: 'us', follow_redirect: 'false', url })) endpoint.searchParams.set(k, v);
      active++; requests++; peak = Math.max(peak, active);
      try {
        if (active > 50) throw Error('BRAND_SEARCH.CONCURRENCY');
        const result = await new Promise((ok, bad) => {
          const req = (broker ? httpRequest : request)(endpoint, { agent: false, signal: AbortSignal.timeout(broker ? 105000 : 90000), headers: { accept: 'text/html', 'accept-encoding': 'identity' } }, res => {
            let size = 0; const chunks = [];
            res.on('data', b => { size += b.length; if (size > 6 * 1024 * 1024) req.destroy(); else chunks.push(b); });
            res.on('error', () => bad(Error('BRAND_SEARCH.RESPONSE_INCOMPLETE')));
            res.on('end', () => ok({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
          });
          req.on('error', () => bad(Error('BRAND_SEARCH.EXECUTION_UNKNOWN'))); req.end();
        });
        await save(stem + '.html', result.bytes);
        const bytes = await fs.readFile(stem + '.html');
        if (hash(bytes) !== hash(result.bytes)) throw Error('BRAND_SEARCH.ARCHIVE_UNVERIFIED');
        const charged = Number(result.headers['sa-credit-cost'] ?? 0); if (Number.isFinite(charged)) credits += charged;
        const receipt = { url, capturedAt: new Date().toISOString(), elapsedMs: Date.now() - start, status: result.status,
          byteSize: bytes.length, sha256: hash(bytes), credits: Number.isFinite(charged) ? charged : null,
          contentType: result.headers['content-type'] ?? null, encoding: result.headers['content-encoding'] ?? null,
          archiveReadbackVerified: true, applicationAttempts: 1 };
        await save(receiptPath, receipt);
        if ([401, 403, 429].includes(result.status)) { halt = true; fatal = 'BRAND_SEARCH.PROVIDER_ADMISSION'; }
        if (result.status === 423) throw Error('BRAND_SEARCH.ADMISSION_WAIT');
        if (result.status !== 200) throw Error('BRAND_SEARCH.HTTP_STATUS');
        if (!String(receipt.contentType).includes('text/html') || receipt.encoding && receipt.encoding !== 'identity') throw Error('BRAND_SEARCH.CONTENT_TYPE');
        if (result.headers['sa-final-url'] && (product ? productAddress(result.headers['sa-final-url']).url : searchAddress(result.headers['sa-final-url'])) !== url) throw Error('BRAND_SEARCH.REDIRECT');
        return { receipt, html: bytes.toString('utf8') };
      } finally { active--; }
    })();
    inflight.set(url, work);
    try { return await work; } finally { if (inflight.get(url) === work) inflight.delete(url); }
  }
  async function one(c) {
    if (!/^[a-f0-9-]{36}$/.test(c.id)) throw Error('BRAND_SEARCH.CANDIDATE');
    const file = join(root, 'results', c.id + '.json');
    const tally = s => { complete++; s === 'verified-search' ? verified++ : s === 'store-link-from-byline' ? storeLinks++ : review++; };
    if (await exists(file)) { tally((await read(file)).state); return; }
    const intent = join(root, 'attempts', c.id + '.json');
    const out = { codec: 'amazon-brand-search-result/1', id: c.id, input: c, state: 'review', code: null, evidence: [],
      productAssociation: 'existing-catalog-mapping-not-reverified', catalogEnumerationComplete: false, databaseImported: false,
      cleanup: { status: 'not_opened', targetIds: [] } };
    try {
      if (await exists(intent)) throw Error('BRAND_SEARCH.PRIOR_ATTEMPT_UNRESOLVED');
      await save(intent, { at: new Date().toISOString(), id: c.id });
      const accepted = names(c); if (!accepted.length) throw Error('BRAND_SEARCH.NAME_REQUIRES_REVIEW');
      if (c.identity?.asin || c.identity?.asins?.length) {
        // Identity mode: read Amazon's byline from the brand's product pages, in order, until one
        // page yields a byline for its own ASIN. Gone, redirected or byline-less pages are skipped.
        const asins = [...(c.identity.asins ?? (c.identity.asin ? [c.identity.asin] : []))], known = new Set(accepted.map(normalizeBrand));
        const max = c.identity.maxProducts ?? asins.length, discover = !!c.identity.discoverFromSearch;
        if (discover) {
          // New products of the brand: organic results of a keyword search for our brand name.
          const q = new URL('https://www.amazon.com/s'); q.searchParams.set('k', accepted[0]); q.searchParams.set('i', 'hpc');
          const s = await capture(q.href); out.evidence.push(s.receipt);
          for (const a of organicAsins(s.html, 6)) if (!asins.includes(a)) asins.push(a);
        }
        let id = null; out.tried = [];
        for (const asin of asins.slice(0, max)) {
          try {
            const page = await capture(`https://www.amazon.com/dp/${asin}`, true); out.evidence.push(page.receipt);
            const b = { ...productByline(page.html, asin), asin };
            // A discovered product counts only when Amazon's byline shows exactly our brand name.
            if (discover && !known.has(normalizeBrand(b.name))) { out.tried.push({ asin, code: 'BRAND_SEARCH.OTHER_BRAND', byline: b.name }); continue; }
            // When a store link is what we need, keep looking if this page's byline has none.
            if (c.identity.needStore && !b.storeUrl && known.has(normalizeBrand(b.name))) { out.tried.push({ asin, code: 'BRAND_SEARCH.NO_STORE_LINK', byline: b.name }); continue; }
            id = b; out.tried.push({ asin, ok: true }); break;
          } catch (e) { if (code(e) === 'BRAND_SEARCH.LOCAL_OR_EXECUTION_UNKNOWN') throw e; out.tried.push({ asin, code: code(e) }); }
        }
        if (!id) throw Error(out.tried.at(-1)?.code ?? 'BRAND_SEARCH.BYLINE_MISSING');
        out.identity = id; out.productAssociation = 'amazon-byline-product-page';
        const fallback = reason => {
          if (!id.storeUrl) throw Error(reason);
          out.state = 'store-link-from-byline'; out.storeUrl = id.storeUrl; out.brandName = id.name; out.searchCode = reason;
        };
        if (accepted.some(n => normalizeBrand(n) === normalizeBrand(id.name))) {
          // The same name was already searched on 2026-09-23 and gave no brand filter.
          fallback('BRAND_SEARCH.BRAND_FILTER_MISSING');
        } else {
          try {
            const q = new URL('https://www.amazon.com/s'); q.searchParams.set('k', id.name); q.searchParams.set('i', 'hpc');
            const first = await capture(q.href); out.evidence.push(first.receipt);
            const observed = inspectSearch(first.html, q.href, [id.name]); out.discovery = observed;
            const filtered = await capture(observed.url); out.evidence.push(filtered.receipt);
            out.verified = inspectSearch(filtered.html, observed.url, [observed.brandName], observed);
            out.brandName = out.verified.brandName; out.searchUrl = out.verified.url;
            out.state = 'verified-search'; out.verifiedAt = filtered.receipt.capturedAt;
          } catch (e) { if (code(e) === 'BRAND_SEARCH.LOCAL_OR_EXECUTION_UNKNOWN') throw e; fallback(code(e)); }
        }
        await save(file, out); tally(out.state);
        console.log(JSON.stringify({ id: c.id, state: out.state, code: out.searchCode ?? null, brandName: out.brandName ?? null, complete }));
        return;
      }
      const query = new URL('https://www.amazon.com/s'); query.searchParams.set('k', accepted[0]); query.searchParams.set('i', 'hpc');
      const first = await capture(query.href); out.evidence.push(first.receipt);
      const observed = inspectSearch(first.html, query.href, accepted);
      out.discovery = observed;
      const filtered = await capture(observed.url); out.evidence.push(filtered.receipt);
      out.verified = inspectSearch(filtered.html, observed.url, [observed.brandName], observed);
      out.brandName = out.verified.brandName; out.searchUrl = out.verified.url;
      out.state = 'verified-search'; out.verifiedAt = filtered.receipt.capturedAt;
    } catch (e) { out.code = code(e); }
    await save(file, out); tally(out.state);
    console.log(JSON.stringify({ id: c.id, state: out.state, code: out.code, brandName: out.brandName ?? null, complete }));
  }
  try {
    await publish('running');
    await Promise.all(Array.from({ length: 50 }, async () => {
      try { while (!halt) { const c = manifest.candidates[cursor++]; if (!c) break; await one(c); } }
      catch (e) { halt = true; fatal = code(e); process.exitCode = 1; }
    }));
  } catch (e) { halt = true; fatal = code(e); process.exitCode = 1; }
  finally {
    clearInterval(timer);
    // Workers normally absorb item errors. A filesystem fatal can leave siblings running;
    // wait for every paid request before releasing the run lock and publishing the final state.
    await Promise.allSettled([...inflight.values()]);
    await publish(halt ? 'paused' : 'completed'); await lock.close(); await fs.unlink(join(root, 'run-lock.json'));
  }
}
