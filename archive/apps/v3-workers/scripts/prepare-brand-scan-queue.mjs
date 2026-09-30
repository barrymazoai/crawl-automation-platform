// Manual, Server 一 only. Turns a finished Amazon brand scan (scan-cli.mjs or store-scan-cli.mjs results and evidence, pulled from Server 二
// into brand-entry/scan-runs/<name>/) into product queue input. Every product found goes to the queue: a product with a
// saved formula only takes a fresh page observation (amazon-formula-once-v1), a product without one gets its formula.
// Report-only unless --write; never queues anything itself.
//   node apps/v3-workers/scripts/prepare-brand-scan-queue.mjs --run <name> [--include-partial] [--write]
// Scan results with state complete or capped are used; review results only with --include-partial (products found
// before the brand stopped). Every scanned page's archive is re-verified (sha256) before its products are used.
// With --write it writes candidates.json, add.json (-> crawler-queue add) and queue-report.json in the run directory.
import fs from 'node:fs'; import { createHash } from 'node:crypto'; import { createRequire } from 'node:module';
import { historyListingId, linkBatches } from '../src/brand-entry/scan-queue.mjs';
const pg = createRequire(import.meta.url)('pg');
const root = '/Users/server/apps/crawler-v3', args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const run = opt('--run'), write = args.includes('--write'), partial = args.includes('--include-partial');
if (!/^[0-9a-z][0-9a-z-]{5,59}$/.test(run ?? '')) throw Error('Usage: --run <name> [--include-partial] [--write]');
const dir = `${root}/brand-entry/scan-runs/${run}`, campaign = `amazon-brand-scan-${run}`;
const sha = s => createHash('sha256').update(s).digest('hex');
const { map } = JSON.parse(fs.readFileSync(dir + '/private-map.json', 'utf8'));
const manifest = JSON.parse(fs.readFileSync(dir + '/manifest.json', 'utf8'));
const m = JSON.parse(fs.readFileSync(root + '/live/deployment.json', 'utf8'));
const db = new pg.Client({ connectionString: m.database.connectionString, statement_timeout: 300000 }); await db.connect();
try {
  await db.query('SET default_transaction_read_only = on');
  const brands = [], problems = [], owner = new Map();
  for (const c of manifest.candidates) {
    const info = map[c.id]; if (!info) { problems.push({ id: c.id, reason: 'not in private map' }); continue; }
    const file = `${dir}/results/${c.id}.json`;
    if (!fs.existsSync(file)) { problems.push({ brand: info.brandName, reason: 'no scan result' }); continue; }
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (r.codec !== 'amazon-brand-scan-result/1' || r.id !== c.id) { problems.push({ brand: info.brandName, reason: 'result identity' }); continue; }
    if (r.state === 'review' && !partial) { problems.push({ brand: info.brandName, reason: 'scan review: ' + r.code, products: r.asins.length }); continue; }
    // Products are used only from pages whose original bytes are here and match the result.
    // Store pages that redirected away from the store were skipped and have no archive.
    const bad = r.pages.filter(p => !p.skipped).find(p => { const f = `${dir}/evidence/${sha(p.url)}.html`; return !fs.existsSync(f) || sha(fs.readFileSync(f)) !== p.sha256; });
    if (bad) { problems.push({ brand: info.brandName, reason: 'page archive missing or changed', page: bad.page }); continue; }
    const asins = r.asins.filter(a => /^[A-Z0-9]{10}$/.test(a));
    const mine = asins.filter(a => { if (owner.has(a)) return false; owner.set(a, info.brandName); return true; });
    brands.push({ id: c.id, info, state: r.state, code: r.code, pages: r.pages.length, totalResults: r.totalResults, asins: mine, sharedWithEarlierBrand: asins.length - mine.length });
  }
  const all = brands.flatMap(b => b.asins);
  const q = async (sql, v) => (await db.query(sql, v)).rows;
  const formula = new Set((await q(`SELECT DISTINCT record->'observation'->>'listingId' asin FROM collected_product
    WHERE record->'observation'->>'listingId' = ANY($1) AND record->>'codec' IN ('collected-product/3','collected-product/4')`, [all])).map(r => r.asin));
  const active = new Set((await q(`SELECT DISTINCT input->'entries'->0->'entry'->>'listingId' asin FROM amazon_queue_item
    WHERE input->'entries'->0->'entry'->>'listingId' = ANY($1) AND state IN ('queued','ready','running')`, [all])).map(r => r.asin));
  // The computed history id must equal the stored one wherever the listing already exists.
  const stored = await q(`SELECT external_id, listing_id FROM product_history_listing WHERE channel='amazon' AND site='amazon.com' AND external_id = ANY($1)`, [all]);
  const mismatch = stored.filter(r => historyListingId(r.external_id) !== r.listing_id);
  if (mismatch.length) throw Error(`history listing id mismatch for ${mismatch.length} ASINs, e.g. ${mismatch[0].external_id}`);
  const inHistory = new Set(stored.map(r => r.external_id));
  const roots = new Map((await q(`SELECT id, brand_id, url, revision, enabled FROM brand_source WHERE id = ANY($1::uuid[])`,
    [[...new Set(brands.map(b => b.info.rootSourceId))]])).map(r => [r.id, r]));
  const candidates = [], perBrand = [];
  for (const b of brands) {
    const s = roots.get(b.info.rootSourceId);
    if (!s || !s.enabled || s.url !== 'https://www.amazon.com/' || s.brand_id !== b.info.brandId) { problems.push({ brand: b.info.brandName, reason: 'root source changed or disabled' }); continue; }
    const scope = { brandId: b.info.brandId, sourceId: s.id, channel: 'amazon', region: 'US', rootUrl: s.url, scopeVersion: `source-revision-${s.revision}` };
    const queued = b.asins.filter(a => !active.has(a));
    for (const asin of queued) candidates.push({ asin, scope, brand: b.info.brandName, historyListingId: historyListingId(asin), hasFormula: formula.has(asin), inHistory: inHistory.has(asin) });
    perBrand.push({ brand: b.info.brandName, scan: b.state, pages: b.pages, totalResults: b.totalResults, found: b.asins.length,
      withFormula: b.asins.filter(a => formula.has(a)).length, withoutFormula: b.asins.filter(a => !formula.has(a)).length,
      alreadyActiveInQueue: b.asins.length - queued.length, sharedWithEarlierBrand: b.sharedWithEarlierBrand });
  }
  const candidateManifest = JSON.stringify({ codec: 'amazon-brand-scan-candidates/1', campaignId: campaign, run,
    rule: 'every scanned product; formula extracted only when none is saved (amazon-formula-once-v1)', candidates });
  const manifestSha = sha(candidateManifest);
  const batches = linkBatches(campaign, candidates, manifestSha);
  const report = { run, campaignId: campaign, brandsScanned: manifest.candidates.length, brandsUsed: perBrand.length, problems: problems.length,
    products: candidates.length, withFormula: candidates.filter(c => c.hasFormula).length, withoutFormula: candidates.filter(c => !c.hasFormula).length,
    notYetInHistory: candidates.filter(c => !c.inHistory).length, alreadyActiveInQueue: all.filter(a => active.has(a)).length,
    batches: batches.length, candidateManifestSha256: manifestSha, written: write ? dir : false };
  if (write) {
    fs.writeFileSync(dir + '/candidates.json', candidateManifest, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(dir + '/add.json', JSON.stringify({ campaignId: campaign, batches }), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(dir + '/queue-report.json', JSON.stringify({ ...report, perBrand, problemDetail: problems }, null, 1), { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify(report));
  if (!write) console.log(JSON.stringify({ perBrand: perBrand.slice(0, 20), problemDetail: problems.slice(0, 20) }));
} finally { await db.end(); }
