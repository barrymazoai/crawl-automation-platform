// Manual, Server 一 only. Builds an Amazon brand scan run (plan docs/spark/2026-09-28-channel-brand-adapters-plan.md,
// phase 1) from brand_source: --kind search (default) takes the stored Brand-filter search URLs and Amazon brand pages
// (scan-cli.mjs, ScraperAPI through the broker); --kind store takes the stored Brand Store pages (store-scan-cli.mjs,
// Ego on Server 二). Only brands that also have an enabled https://www.amazon.com/ root source are selected, because
// the product queue needs that scope. Report-only unless --write; never starts a scan or queues anything.
//   node apps/v3-workers/scripts/prepare-brand-scan.mjs --run <name> [--kind search|store] [--brands "A|B"] [--limit N]
//        [--concurrency N] [--max-pages N] [--write]
// With --write it writes, under brand-entry/scan-runs/<name>/:
//   manifest.json      amazon-brand-scan/1 or amazon-store-scan/1: random ids and public URLs only (goes to Server 二)
//   private-map.json   id -> brand, URL source and root source; stays on Server 一
import fs from 'node:fs'; import { randomUUID } from 'node:crypto'; import { createRequire } from 'node:module';
import { scanAddress } from '../../../packages/v3-channels/src/amazon-brand-search.mjs';
import { storeAddress } from '../../../packages/v3-channels/src/amazon-store-scan.mjs';
const pg = createRequire(import.meta.url)('pg');
const root = '/Users/server/apps/crawler-v3', args = process.argv.slice(2);
const opt = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const run = opt('--run'), write = args.includes('--write'), kind = opt('--kind', 'search'), store = kind === 'store';
const limit = opt('--limit') === null ? null : Number(opt('--limit'));
const concurrency = Number(opt('--concurrency', store ? '2' : '10')), maxPages = Number(opt('--max-pages', store ? '50' : '20'));
const brands = opt('--brands')?.split('|').map(s => s.trim().toLowerCase()).filter(Boolean) ?? null;
if (!/^[0-9a-z][0-9a-z-]{5,59}$/.test(run ?? '') || !['search', 'store'].includes(kind) || (limit !== null && !(Number.isInteger(limit) && limit > 0)) ||
    !(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= (store ? 3 : 50)) || !(Number.isInteger(maxPages) && maxPages >= 1 && maxPages <= (store ? 60 : 50)))
  throw Error('Usage: --run <name> [--kind search|store] [--brands "A|B"] [--limit N] [--concurrency 1-50 (store 1-3)] [--max-pages 1-50 (store 1-60)] [--write]');
const out = `${root}/brand-entry/scan-runs/${run}`;
if (write && fs.existsSync(out)) throw Error(`Run directory already exists: ${out}`);
const m = JSON.parse(fs.readFileSync(root + '/live/deployment.json', 'utf8'));
const db = new pg.Client({ connectionString: m.database.connectionString, statement_timeout: 120000 }); await db.connect();
try {
  await db.query('SET default_transaction_read_only = on');
  const rows = (await db.query(`SELECT s.id source_id, s.url, b.id brand_id, b.name brand_name,
      (SELECT jsonb_build_object('id', r.id, 'revision', r.revision) FROM brand_source r WHERE r.brand_id = b.id AND r.channel = 'amazon'
         AND r.region = 'US' AND r.url = 'https://www.amazon.com/' AND r.enabled ORDER BY r.created_at LIMIT 1) root
    FROM brand_source s JOIN brand b ON b.id = s.brand_id
    WHERE s.channel = 'amazon' AND s.region = 'US' AND s.url LIKE $1
    ORDER BY lower(b.name), s.url`, [store ? 'https://www.amazon.com/stores/%' : 'https://www.amazon.com/s?%'])).rows;
  const skipped = [], usable = [];
  for (const r of rows) {
    let address; try { address = store ? { ...storeAddress(r.url), kind: 'store' } : scanAddress(r.url); } catch (e) { skipped.push({ brand: r.brand_name, reason: 'url not scannable: ' + e.message }); continue; }
    if (!r.root) { skipped.push({ brand: r.brand_name, reason: 'no enabled amazon.com root source' }); continue; }
    usable.push({ ...r, kind: address.kind, scanUrl: address.url });
  }
  let selected = brands ? usable.filter(r => brands.includes(r.brand_name.toLowerCase())) : usable;
  if (brands) for (const b of brands) if (!selected.some(r => r.brand_name.toLowerCase() === b)) skipped.push({ brand: b, reason: 'requested brand not found among usable brand URLs' });
  if (limit !== null) selected = selected.slice(0, limit);
  const candidates = selected.map(r => ({ id: randomUUID(), url: r.scanUrl }));
  const map = Object.fromEntries(selected.map((r, i) => [candidates[i].id, { brandId: r.brand_id, brandName: r.brand_name, urlSourceId: r.source_id,
    url: r.url, kind: r.kind, rootSourceId: r.root.id, rootRevision: r.root.revision }]));
  const report = { run, kind, brandUrls: rows.length, usable: usable.length, selected: selected.length,
    kinds: selected.reduce((a, r) => (a[r.kind] = (a[r.kind] ?? 0) + 1, a), {}),
    skipped: skipped.length, skippedReasons: skipped.reduce((a, s) => (a[s.reason.replace(/:.*/, '')] = (a[s.reason.replace(/:.*/, '')] ?? 0) + 1, a), {}),
    concurrency, maxPages, maxRequests: selected.length * maxPages, written: write ? out : false };
  if (write) {
    fs.mkdirSync(out, { recursive: true, mode: 0o700 });
    fs.writeFileSync(out + '/manifest.json', JSON.stringify({ codec: store ? 'amazon-store-scan/1' : 'amazon-brand-scan/1', concurrency, maxPages, createdAt: new Date().toISOString(), candidates }, null, 1), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(out + '/private-map.json', JSON.stringify({ codec: 'amazon-brand-scan-map/1', run, map }, null, 1), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(out + '/prepare-report.json', JSON.stringify({ ...report, skippedDetail: skipped }, null, 1), { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify(report));
} finally { await db.end(); }
