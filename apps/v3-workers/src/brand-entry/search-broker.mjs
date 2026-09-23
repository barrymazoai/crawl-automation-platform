// Temporary search-only transport. API credential never leaves the primary Mini.
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { searchAddress, filterIdentity } from '../../../../packages/v3-channels/src/amazon-brand-search.mjs';
const root = resolve(process.argv[2]), manifest = JSON.parse(await fs.readFile(join(root, 'manifest.json'), 'utf8'));
const allowedNames = new Set(manifest.candidates.flatMap(c => c.names.map(n => n.normalize('NFKC').replace(/\s+/g, ' ').trim())));
const deployment = JSON.parse(await fs.readFile('/Users/server/apps/crawler-v3/live/deployment.json', 'utf8'));
const cfg = JSON.parse(await fs.readFile(deployment.jobs.find(j => j.env.V3_AMAZON_LIVE_CONFIG).env.V3_AMAZON_LIVE_CONFIG, 'utf8'));
const key = cfg.capture.scraperApi.apiKey;
await fs.mkdir(join(root, 'evidence'), { recursive: true, mode: 0o700 });
const hash = b => createHash('sha256').update(b).digest('hex');
const save = async (p, b) => { const f = await fs.open(p, 'wx', 0o600); try { await f.writeFile(b); await f.sync(); } finally { await f.close(); } };
let active = 0, peak = 0, calls = 0, charged = 0;
const pending = new Map();
async function once(url) {
  const stem = join(root, 'evidence', hash(url));
  try {
    const receipt = JSON.parse(await fs.readFile(stem + '.json', 'utf8')), bytes = await fs.readFile(stem + '.html');
    if (hash(bytes) !== receipt.sha256) throw Error('ARCHIVE');
    return { status: receipt.status, headers: { ...receipt.headers, 'sa-credit-cost': '0' }, bytes };
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (active >= 50 || calls >= manifest.candidates.length * 2) throw Error('LIMIT');
  await save(stem + '.intent.json', JSON.stringify({ url, at: new Date().toISOString(), attempts: 1 }));
  active++; peak = Math.max(peak, active); calls++;
  try {
    const endpoint = new URL('https://api.scraperapi.com/');
    for (const [k, v] of Object.entries({ api_key: key, country_code: 'us', follow_redirect: 'false', url })) endpoint.searchParams.set(k, v);
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
    await save(stem + '.json', JSON.stringify({ url, capturedAt: new Date().toISOString(), status: result.status, headers: result.headers, sha256: hash(bytes), byteSize: bytes.length }));
    const cost = Number(result.headers['sa-credit-cost'] ?? 0); if (Number.isFinite(cost)) charged += cost;
    if (result.finalUrl && searchAddress(result.finalUrl) !== url) throw Error('REDIRECT');
    return result;
  } finally { active--; }
}
const server = createServer(async (req, res) => {
  if (req.socket.remoteAddress !== '100.84.91.3' || req.method !== 'GET') { res.writeHead(403).end(); return; }
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/health') { res.setHeader('content-type','application/json'); res.end(JSON.stringify({ active, peak, calls, charged, concurrency: 50 })); return; }
    if (u.pathname !== '/capture') throw Error('PATH');
    const url = searchAddress(u.searchParams.get('url')), target = new URL(url);
    if (!allowedNames.has(target.searchParams.get('k'))) throw Error('NAME');
    if (target.searchParams.has('rh')) filterIdentity(url);
    let work = pending.get(url);
    if (!work) { work = once(url); pending.set(url, work); }
    let result; try { result = await work; } finally { if (pending.get(url) === work) pending.delete(url); }
    res.writeHead(result.status, result.headers); res.end(result.bytes);
  } catch (e) {
    const status = e.message === 'LIMIT' ? 429 : e.code === 'EEXIST' ? 409 : 502;
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 'BRAND_SEARCH.BROKER_STOP', retryAllowed: false }));
  }
});
server.requestTimeout = 110000;
server.listen(19419, '100.76.126.12', () => console.log(JSON.stringify({ event:'BROKER_READY', pid:process.pid, bind:'100.76.126.12:19419', allowedSource:'100.84.91.3', candidates:manifest.candidates.length })));
process.once('SIGTERM', () => server.close()); process.once('SIGINT', () => server.close());
