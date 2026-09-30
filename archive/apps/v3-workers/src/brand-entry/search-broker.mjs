// Temporary search-only transport. API credential never leaves the primary Mini.
// Product pages are allowed only for ASINs listed in the run manifest, only after the
// shared 24-hour Amazon HTML admission ledger shows no attempt for that ASIN, and only
// to read the brand byline; the byline name then becomes an allowed search name.
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { searchAddress, filterIdentity, productAddress, productByline, organicAsins, scanAddress, scanPageUrl } from '../../../../packages/v3-channels/src/amazon-brand-search.mjs';
import { gncScanAddress, gncScanPageUrl } from '../../../../packages/v3-channels/src/gnc-brand-scan.mjs';
import { swansonScanAddress, swansonScanPageUrl } from '../../../../packages/v3-channels/src/swanson-brand-scan.mjs';
const root = resolve(process.argv[2]), manifest = JSON.parse(await fs.readFile(join(root, 'manifest.json'), 'utf8'));
const clean = n => n.normalize('NFKC').replace(/\s+/g, ' ').trim();
// Brand scan runs may fetch only the listed brand URLs, pages 1..maxPages (Amazon, GNC or Swanson products.json).
const scanSite = { 'amazon-brand-scan/1': { address: raw => scanAddress(raw).url, pageUrl: scanPageUrl }, 'gnc-brand-scan/1': { address: raw => gncScanAddress(raw).url, pageUrl: gncScanPageUrl },
  'swanson-brand-scan/1': { address: raw => swansonScanAddress(raw).url, pageUrl: swansonScanPageUrl } }[manifest.codec];
const scan = !!scanSite;
if (scan && !(Number.isInteger(manifest.maxPages) && manifest.maxPages >= 1 && manifest.maxPages <= 50)) throw Error('MANIFEST');
const allowedScan = new Set(scan ? manifest.candidates.flatMap(c => Array.from({ length: manifest.maxPages }, (_, i) => scanSite.pageUrl(c.url, i + 1))) : []);
const allowedNames = new Set(scan ? [] : manifest.candidates.flatMap(c => c.names.map(clean)));
const allowedAsins = new Set(scan ? [] : manifest.candidates.flatMap(c => [c.identity?.asin, ...(c.identity?.asins ?? [])]).filter(Boolean));
// Set only when the user explicitly authorized refetching despite a recent attempt (2026-09-24).
const skipAdmission = manifest.admission === 'user-authorized-refetch';
const deployment = JSON.parse(await fs.readFile('/Users/server/apps/crawler-v3/live/deployment.json', 'utf8'));
const cfg = JSON.parse(await fs.readFile(deployment.jobs.find(j => j.env.V3_AMAZON_LIVE_CONFIG).env.V3_AMAZON_LIVE_CONFIG, 'utf8'));
const key = cfg.capture.scraperApi.apiKey;
const db = (allowedAsins.size || manifest.candidates.some(c => c.identity?.discoverFromSearch)) ? new pg.Pool({ connectionString: deployment.database.connectionString, max: 2, statement_timeout: 10000 }) : null;
await fs.mkdir(join(root, 'evidence'), { recursive: true, mode: 0o700 });
const hash = b => createHash('sha256').update(b).digest('hex');
const save = async (p, b) => { const f = await fs.open(p, 'wx', 0o600); try { await f.writeFile(b); await f.sync(); } finally { await f.close(); } };
const ledger = v => fs.appendFile(join(root, 'product-fetches.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...v }) + '\n');
const discoveryLimit = manifest.candidates.reduce((n, c) => n + (c.identity?.discoverFromSearch ? (c.identity.maxProducts ?? 4) : 0), 0);
const limit = scan ? allowedScan.size : manifest.candidates.length * 3 + allowedAsins.size + discoveryLimit;
// Search-discovered ASINs become fetchable only from search pages this broker fetched itself.
const discoverNames = new Set(manifest.candidates.filter(c => c.identity?.discoverFromSearch).flatMap(c => c.names.map(clean)));
const learnResults = (url, bytes) => { try { const u = new URL(url); if (!u.searchParams.has('rh') && discoverNames.has(u.searchParams.get('k'))) for (const a of organicAsins(bytes.toString('utf8'), 6)) allowedAsins.add(a); } catch {} };
const concurrency = manifest.concurrency;
if (!(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 50)) throw Error('MANIFEST');
let active = 0, peak = 0, calls = 0, charged = 0;
const pending = new Map();
const learn = (url, bytes) => {
  try { const { asin } = productAddress(url); allowedNames.add(clean(productByline(bytes.toString('utf8'), asin).name)); } catch {}
};
async function once(url, product) {
  const stem = join(root, 'evidence', hash(url));
  try {
    const receipt = JSON.parse(await fs.readFile(stem + '.json', 'utf8')), bytes = await fs.readFile(stem + '.html');
    if (hash(bytes) !== receipt.sha256) throw Error('ARCHIVE');
    if (product) learn(url, bytes); else if (!scan) learnResults(url, bytes);
    return { status: receipt.status, headers: { ...receipt.headers, 'sa-credit-cost': '0' }, bytes };
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (active >= concurrency || calls >= limit) throw Error('LIMIT');
  if (product) {
    // Shared rolling 24h admission: any attempt on this ASIN (captured or not) blocks a paid fetch.
    const { asin } = productAddress(url);
    const recent = (await db.query(`SELECT 1 FROM amazon_html_fetch WHERE site='https://www.amazon.com' AND asin=$1
      AND greatest(requested_at,coalesce(captured_at,requested_at))>clock_timestamp()-interval '24 hours' LIMIT 1`, [asin])).rowCount;
    if (recent && !skipAdmission) { await ledger({ asin, event: 'ADMISSION_WAIT' }); throw Error('ADMISSION'); }
    if (recent) await ledger({ asin, event: 'ADMISSION_SKIPPED_BY_USER' });
  }
  await save(stem + '.intent.json', JSON.stringify({ url, at: new Date().toISOString(), attempts: 1 }));
  active++; peak = Math.max(peak, active); calls++;
  try {
    const endpoint = new URL('https://api.scraperapi.com/');
    // Product pages commonly 301 to a slugged URL of the same ASIN; the final ASIN is checked below.
    for (const [k, v] of Object.entries({ api_key: key, country_code: 'us', follow_redirect: product ? 'true' : 'false', url })) endpoint.searchParams.set(k, v);
    const result = await new Promise((ok, bad) => {
      const req = request(endpoint, { agent: false, signal: AbortSignal.timeout(90000), headers: { accept: 'text/html', 'accept-encoding': 'identity' } }, res => {
        const chunks = []; let size = 0;
        res.on('data', b => { size += b.length; if (size > 6 * 1024 * 1024) req.destroy(); else chunks.push(b); });
        res.on('error', () => bad(Error('INCOMPLETE')));
        res.on('end', () => ok({ status: res.statusCode, headers: Object.fromEntries(['content-type','content-encoding','sa-credit-cost'].filter(k=>res.headers[k]).map(k=>[k,res.headers[k]])), bytes: Buffer.concat(chunks), finalUrl: res.headers['sa-final-url'] }));
      }); req.on('error', () => bad(Error('UNKNOWN'))); req.end();
    });
    // Store full response before returning it; a lost downstream acknowledgment cannot cause a second paid fetch.
    await save(stem + '.html', result.bytes);
    const bytes = await fs.readFile(stem + '.html'); if (hash(bytes) !== hash(result.bytes)) throw Error('ARCHIVE');
    await save(stem + '.json', JSON.stringify({ url, capturedAt: new Date().toISOString(), status: result.status, headers: result.headers, sha256: hash(bytes), byteSize: bytes.length, finalUrl: result.finalUrl ?? null }));
    const cost = Number(result.headers['sa-credit-cost'] ?? 0); if (Number.isFinite(cost)) charged += cost;
    if (product) {
      await ledger({ asin: productAddress(url).asin, event: 'FETCHED', status: result.status, sha256: hash(bytes), bytes: bytes.length, finalUrl: result.finalUrl ?? null });
      if (result.finalUrl && productAddress(result.finalUrl).asin !== productAddress(url).asin) throw Error('REDIRECT');
      learn(url, bytes);
    } else if (scan) { if (result.finalUrl) { let final = null; try { final = scanSite.address(result.finalUrl); } catch {} if (final !== url) throw Error('REDIRECT'); } }
    else { if (result.finalUrl && searchAddress(result.finalUrl) !== url) throw Error('REDIRECT'); if (result.status === 200) learnResults(url, bytes); }
    return result;
  } finally { active--; }
}
const server = createServer(async (req, res) => {
  if (req.socket.remoteAddress !== '100.84.91.3' || req.method !== 'GET') { res.writeHead(403).end(); return; }
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/health') { res.setHeader('content-type','application/json'); res.end(JSON.stringify({ active, peak, calls, charged, concurrency })); return; }
    if (u.pathname !== '/capture') throw Error('PATH');
    const raw = u.searchParams.get('url'), product = !scan && /\/dp\//.test(new URL(raw).pathname);
    let url;
    if (product) { const p = productAddress(raw); if (!allowedAsins.has(p.asin)) throw Error('ASIN'); url = p.url; }
    else if (scan) { url = scanSite.address(raw); if (!allowedScan.has(url)) throw Error('NAME'); }
    else { url = searchAddress(raw); if (!allowedNames.has(new URL(url).searchParams.get('k'))) throw Error('NAME'); if (new URL(url).searchParams.has('rh')) filterIdentity(url); }
    let work = pending.get(url);
    if (!work) { work = once(url, product); pending.set(url, work); }
    let result; try { result = await work; } finally { if (pending.get(url) === work) pending.delete(url); }
    res.writeHead(result.status, result.headers); res.end(result.bytes);
  } catch (e) {
    const status = e.message === 'LIMIT' ? 429 : e.message === 'ADMISSION' ? 423 : e.code === 'EEXIST' ? 409 : 502;
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: e.message === 'ADMISSION' ? 'BRAND_SEARCH.ADMISSION_WAIT' : 'BRAND_SEARCH.BROKER_STOP', retryAllowed: false }));
  }
});
server.requestTimeout = 110000;
server.listen(19419, '100.76.126.12', () => console.log(JSON.stringify({ event:'BROKER_READY', pid:process.pid, bind:'100.76.126.12:19419', allowedSource:'100.84.91.3', candidates:manifest.candidates.length, productAsins:allowedAsins.size, scanPages:allowedScan.size })));
process.once('SIGTERM', () => { server.close(); db?.end(); }); process.once('SIGINT', () => { server.close(); db?.end(); });
