import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import pg from 'pg';
import { BrandEntryLedger } from '../src/brand-entry/ledger.js';
import { baseOutcome, workflowId, type Candidate, type Seed, type Outcome } from '../src/brand-entry/contracts.js';

const address = process.env.V3_BRAND_ENTRY_TEST_URL;
describe.skipIf(!address)('isolated Mini Brand preparation ledger', () => {
  let db: pg.Pool, ledger: BrandEntryLedger;
  beforeAll(async () => {
    if (!/Mac-mini/i.test(hostname()) || process.env.V3_BRAND_ENTRY_ISOLATED !== 'true') throw Error('Isolated Mini required');
    db = new pg.Pool({ connectionString: address, max: 4 }); ledger = new BrandEntryLedger(db);
    if ((await db.query('SELECT current_database() name')).rows[0].name !== 'crawler_v3_test' ||
        (await db.query("SELECT to_regclass('public.brand') name")).rows[0].name) throw Error('Empty test database required');
    await db.query(await readFile(new URL('../../../database/v3/001_brand_sources.sql', import.meta.url), 'utf8'));
    await db.query(await readFile(new URL('../../../database/v3-brand-entry/001_preparation.sql', import.meta.url), 'utf8'));
  });
  afterAll(async () => { await db?.end(); });
  const candidate = (): Candidate => ({ companyId: randomUUID(), name: 'Legacy company', nameVariants: [], databases: ['legacy'], existingBrandIds: [],
    existingBrandNames: [], sampleUrl: 'https://www.amazon.com/dp/B000000001', missingFromPreviousBrandList: true, amazonListings: [{ site: 'amazon.com', asin: 'B000000001' }] });
  async function started(input = candidate()) {
    const call = { campaignId: randomUUID(), candidateId: input.companyId }, runId = randomUUID();
    await ledger.import(call.campaignId, [input]); await ledger.claim(call, workflowId(call), runId);
    return { call, input, runId };
  }
  async function verified(input = candidate()) {
    const x = await started(input), url = `https://www.amazon.com/stores/Example/page/${randomUUID()}`;
    const ref = { key: 'test/original.html', sha256: 'a'.repeat(64), byteSize: 20, mediaType: 'text/html' };
    const seed: Seed = { ...x.call, candidate: input, asin: 'B000000001', productUrl: input.sampleUrl, name: `Verified ${randomUUID()}`,
      brandRaw: 'Visit the Verified Store', storeUrl: url, capturedAt: '2026-09-20T00:00:00.000Z', original: ref, receipt: { ...ref, key: 'test/receipt.json' } };
    await ledger.saveSeed(x.call, seed);
    const out: Outcome = { ...baseOutcome(x.call, 'verified', 'BRAND_ENTRY.VERIFIED'), seed,
      pages: [{ requestedUrl: url, finalUrl: url, capturedAt: '2026-09-23T00:00:00.000Z', status: 200, original: ref, rendered: ref, snapshot: ref,
        responseRepresentation: 'fetch-response-base64', title: seed.name, productCount: 2 }],
      directories: [{ url, text: 'Shop All', pageIndex: 0 }], directoryKind: 'all_products',
      cleanup: { status: 'closed', targetIds: ['owned'], checkedAt: '2026-09-23T00:00:01.000Z' }, verifiedAt: '2026-09-23T00:00:00.000Z' };
    return { ...x, out };
  }
  it('imports once, rejects changed identity, and never requeues a terminal failure', async () => {
    const x = await started();
    expect(await ledger.import(x.call.campaignId, [x.input])).toEqual({ imported: false, total: 1 });
    await expect(ledger.import(x.call.campaignId, [{ ...x.input, name: 'changed' }])).rejects.toThrow('MANIFEST_CONFLICT');
    await expect(ledger.claim(x.call, workflowId(x.call), randomUUID())).rejects.toThrow('OWNER');
    const failure = baseOutcome(x.call, 'failed', 'BRAND_ENTRY.TIME_LIMIT');
    await ledger.finish(failure); expect(await ledger.finish(failure)).toEqual(failure);
    expect(await ledger.pending(x.call.campaignId, 10)).toEqual([]);
    await expect(db.query("UPDATE brand_entry.candidate SET state='pending',result=NULL WHERE campaign_id=$1", [x.call.campaignId])).rejects.toThrow();
  });
  it('does not publish a mapping or Brand while page cleanup is pending', async () => {
    const x = await verified(); x.out.cleanup.status = 'pending';
    await expect(ledger.finish(x.out)).rejects.toThrow('RESULT_UNVERIFIED');
    expect((await db.query('SELECT count(*)::int n FROM brand_entry.mapping WHERE campaign_id=$1', [x.call.campaignId])).rows[0].n).toBe(0);
    expect((await ledger.get(x.call)).state).toBe('running');
  });
  it('atomically publishes a new disabled source and reads back a lost receipt idempotently', async () => {
    const x = await verified(); await ledger.finish(x.out); await ledger.finish(x.out);
    const rows = (await db.query('SELECT s.enabled FROM brand_entry.mapping m JOIN brand_source s ON s.id=ANY(m.source_ids) WHERE m.campaign_id=$1', [x.call.campaignId])).rows;
    expect(rows).toEqual([{ enabled: false }]); expect((await ledger.get(x.call)).result).toEqual(x.out);
    await expect(ledger.saveSeed(x.call, { ...x.out.seed!, name: 'changed' })).rejects.toThrow('SEED_CONFLICT');
  });
  it('retains an existing source enabled flag and refuses name-only Brand merging', async () => {
    const brandId = randomUUID(); await db.query('INSERT INTO brand(id,name) VALUES($1,$2)', [brandId, `Existing ${brandId}`]);
    const input = candidate(); input.existingBrandIds = [brandId];
    const x = await verified(input);
    await db.query("INSERT INTO brand_source(brand_id,channel,region,url,enabled) VALUES($1,'amazon','US',$2,true)", [brandId, x.out.directories[0]!.url]);
    await ledger.finish(x.out);
    expect((await db.query('SELECT enabled,revision FROM brand_source WHERE brand_id=$1', [brandId])).rows).toEqual([{ enabled: true, revision: 1 }]);
    const conflict = await verified(); await db.query('INSERT INTO brand(name) VALUES($1)', [conflict.out.seed!.name]);
    await expect(ledger.finish(conflict.out)).rejects.toThrow('BRAND_NAME_CONFLICT');
    expect((await db.query('SELECT count(*)::int n FROM brand_entry.mapping WHERE campaign_id=$1', [conflict.call.campaignId])).rows[0].n).toBe(0);
    await ledger.finish({ ...conflict.out, state: 'review', code: 'BRAND_ENTRY.BRAND_NAME_CONFLICT', verifiedAt: null });
    expect(await ledger.pending(conflict.call.campaignId, 10)).toEqual([]);
  });
  it('rolls back a Brand and earlier sources if a later directory fails verification', async () => {
    const x = await verified(); x.out.directories.push({ url: x.out.directories[0]!.url, text: 'Invalid page', pageIndex: 7 });
    await expect(ledger.finish(x.out)).rejects.toThrow('DIRECTORY_UNVERIFIED');
    expect((await db.query('SELECT count(*)::int n FROM brand WHERE name=$1', [x.out.seed!.name])).rows[0].n).toBe(0);
    expect((await ledger.get(x.call)).result).toBeNull();
  });
});
