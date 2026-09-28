// Manual (user-approved 2026-09-28: "check how many products are already processed and verified whose metrics are
// missing, just fix them"). Selects Amazon products whose formula is saved (collected_product) but whose latest page
// observation predates the 2026-09-23 sales/price parser fix (c5e397a, eddaff7), and prepares them for one rerun. A
// rerun with a saved formula only takes a fresh page observation (amazon-formula-once-v1): no image, OCR or model work.
//   node apps/v3-workers/scripts/prepare-metrics-rerun-20260928.mjs [--write]
// Without --write it only reports. With --write it writes, under manual-releases/metrics-rerun-20260928/:
//   candidates.json  every selected ASIN with its listing, scope and last observation time (its sha256 is the
//                    candidateManifestSha256 of every batch below)
//   requeue.json     item ids already in the queue (completed) -> crawler-queue requeue
//   add.json         one-entry batches for the rest -> crawler-queue add
// It never queues anything itself.
import fs from 'node:fs'; import { createHash, randomUUID } from 'node:crypto'; import { createRequire } from 'node:module';
const pg = createRequire(import.meta.url)('pg');
const root = '/Users/server/apps/crawler-v3', out = root + '/manual-releases/metrics-rerun-20260928', write = process.argv.includes('--write');
const FIX = '2026-09-23T04:40:00Z', CAMPAIGN = 'amazon-metrics-rerun-20260928';
const sha = s => createHash('sha256').update(s).digest('hex');
const m = JSON.parse(fs.readFileSync(root + '/live/deployment.json', 'utf8'));
const db = new pg.Client({ connectionString: m.database.connectionString, statement_timeout: 300000 }); await db.connect();
try {
  // The latest saved formula per ASIN gives the scope the product was collected under.
  const rows = (await db.query(`WITH verified AS (
      SELECT DISTINCT ON (record->'observation'->>'listingId') record->'observation'->>'listingId' asin,
        record->'observation'->>'brandId' brand_id, record->'observation'->>'sourceId' source_id
      FROM collected_product WHERE record->'observation'->>'listingId' ~ '^[A-Z0-9]{10}$'
      ORDER BY record->'observation'->>'listingId', collected_at DESC NULLS LAST),
    latest AS (
      SELECT DISTINCT ON (l.external_id) l.external_id asin, l.listing_id, o.observed_at
      FROM product_history_observation o JOIN product_history_listing l USING(listing_id)
      WHERE l.channel='amazon' AND o.kind='metrics' ORDER BY l.external_id, o.observed_at DESC)
    SELECT v.asin, v.brand_id, v.source_id, latest.listing_id, latest.observed_at, s.region, s.channel, s.url, s.enabled, s.revision
    FROM verified v JOIN latest USING(asin) LEFT JOIN brand_source s ON s.id::text = v.source_id
    WHERE latest.observed_at < $1 ORDER BY v.asin`, [FIX])).rows;
  const usable = rows.filter(r => r.enabled && r.channel === 'amazon' && r.url === 'https://www.amazon.com/' && r.brand_id);
  const skipped = rows.filter(r => !usable.includes(r)).map(r => ({ asin: r.asin, reason: !r.region ? 'source missing' : !r.enabled ? 'source disabled' : 'source not amazon.com root' }));
  const queued = new Map((await db.query(`SELECT item_id, state, input->'entries'->0->'entry'->>'listingId' asin FROM amazon_queue_item
    WHERE input->'entries'->0->'entry'->>'listingId' = ANY($1)`, [usable.map(r => r.asin)])).rows.map(r => [r.asin, r]));
  const candidates = usable.map(r => ({ asin: r.asin, historyListingId: r.listing_id, lastObservedAt: r.observed_at,
    scope: { region: r.region, brandId: r.brand_id, channel: 'amazon', rootUrl: r.url, sourceId: r.source_id, scopeVersion: `source-revision-${r.revision}` } }));
  const manifest = JSON.stringify({ codec: 'metrics-rerun-candidates/1', campaignId: CAMPAIGN, criteria: { formulaSaved: 'collected_product', latestObservationBefore: FIX }, candidates });
  const manifestSha = sha(manifest);
  const requeue = candidates.filter(c => ['completed', 'review'].includes(queued.get(c.asin)?.state)).map(c => queued.get(c.asin).item_id);
  const busy = candidates.filter(c => queued.has(c.asin) && !['completed', 'review'].includes(queued.get(c.asin).state)).map(c => c.asin);
  const add = candidates.filter(c => !queued.has(c.asin)).map(c => ({ codec: 'amazon-link-batch/1', requestId: randomUUID(), scope: c.scope,
    candidateManifestSha256: manifestSha, entries: [{ entry: { url: `https://www.amazon.com/dp/${c.asin}`, kind: 'product', listingId: c.asin, variantId: null },
      candidateId: sha(JSON.stringify([CAMPAIGN, c.asin])), historyListingId: c.historyListingId }] }));
  const report = { selected: rows.length, usable: usable.length, skipped: skipped.length, skippedReasons: Object.entries(skipped.reduce((a, s) => (a[s.reason] = (a[s.reason] ?? 0) + 1, a), {})),
    requeue: requeue.length, add: add.length, alreadyActive: busy.length, candidateManifestSha256: manifestSha };
  if (write) {
    fs.mkdirSync(out, { recursive: true, mode: 0o700 });
    fs.writeFileSync(out + '/candidates.json', manifest, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(out + '/skipped.json', JSON.stringify(skipped), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(out + '/requeue.json', JSON.stringify(requeue), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(out + '/add.json', JSON.stringify({ campaignId: CAMPAIGN, batches: add }), { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify({ ...report, written: write ? out : false }));
} finally { await db.end(); }
