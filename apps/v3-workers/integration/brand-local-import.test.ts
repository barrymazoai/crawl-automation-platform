import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import pg from 'pg';
import { LocalBrandImporter, importedBrandId } from '../src/brand-entry/importer.js';
import { baseOutcome, type ObjectProof, type Outcome } from '../src/brand-entry/contracts.js';

const address = process.env.V3_BRAND_ENTRY_TEST_URL;
describe.skipIf(!address)('standalone Brand importer on isolated Mini PostgreSQL', () => {
  let db: pg.Pool, importer: LocalBrandImporter;
  beforeAll(async () => {
    if (!/Mac-mini/i.test(hostname()) || process.env.V3_BRAND_ENTRY_ISOLATED !== 'true') throw Error('Isolated Mini required');
    db = new pg.Pool({ connectionString: address, max: 2 }); importer = new LocalBrandImporter(db);
    if ((await db.query('SELECT current_database() name')).rows[0].name !== 'crawler_v3_test' ||
        (await db.query("SELECT to_regclass('public.brand') name")).rows[0].name) throw Error('Empty test database required');
    await db.query(await readFile(new URL('../../../database/v3/001_brand_sources.sql', import.meta.url), 'utf8'));
  });
  afterAll(async () => { await db?.end(); });
  function example(): Outcome {
    const call = { campaignId: randomUUID(), candidateId: randomUUID() }, url = `https://www.amazon.com/stores/Example/page/${randomUUID()}`;
    const ref = (key: string): ObjectProof => ({ key, sha256: 'a'.repeat(64), byteSize: 20, mediaType: 'text/html' });
    const prefix = `v3/brand-entry/${call.campaignId}/${call.candidateId}/pages/0/`, refs = ['original.html', 'original.json', 'rendered.html', 'snapshot.txt'].map(x => ref(prefix + x));
    const out = baseOutcome(call, 'verified', 'BRAND_ENTRY.VERIFIED');
    out.seed = { ...call, candidate: { companyId: call.candidateId, name: 'ASIN B000000001', nameVariants: [], databases: [], existingBrandIds: [], existingBrandNames: [], sampleUrl: 'https://www.amazon.com/dp/B000000001', missingFromPreviousBrandList: false, amazonListings: [{ site: 'amazon.com', asin: 'B000000001' }] }, asin: 'B000000001', productUrl: 'https://www.amazon.com/dp/B000000001', name: `Verified ${randomUUID()}`, brandRaw: 'Example', storeUrl: url, capturedAt: '2026-09-23T00:00:00.000Z', original: ref('seed/original.html'), receipt: ref('seed/original.json') };
    out.pages = [{ requestedUrl: url, finalUrl: url, capturedAt: out.seed.capturedAt, status: 200, original: refs[0]!, rendered: refs[2]!, snapshot: refs[3]!, responseRepresentation: 'fetch-response-base64', title: out.seed.name, productCount: 2 }];
    out.evidence = refs; out.directories = [{ url, text: 'Shop All', pageIndex: 0 }]; out.directoryKind = 'all_products';
    out.cleanup = { status: 'closed', targetIds: ['owned'], checkedAt: out.seed.capturedAt }; out.verifiedAt = out.seed.capturedAt; return out;
  }
  it('imports twice without creating duplicate Brands or sources; new source remains disabled', async () => {
    const out = example(), first = await importer.apply(out), second = await importer.apply(out);
    expect(first).toEqual(second); expect(first.brandId).toBe(importedBrandId(out));
    expect((await db.query('SELECT enabled,revision FROM brand_source WHERE brand_id=$1', [first.brandId])).rows).toEqual([{ enabled: false, revision: 1 }]);
    expect((await importer.existing(out)).complete).toBe(true);
  });
  it('preserves an existing enabled source, and refuses a renamed private Brand identity', async () => {
    const out = example(), id = randomUUID(), name = `Existing ${id}`;
    out.seed!.name = name;
    out.seed!.candidate.existingBrandIds = [id]; out.seed!.candidate.existingBrandNames = [name];
    await db.query('INSERT INTO brand(id,name) VALUES($1,$2)', [id, name]);
    await db.query("INSERT INTO brand_source(brand_id,channel,region,url,enabled) VALUES($1,'amazon','US',$2,true)", [id, out.directories[0]!.url]);
    await importer.apply(out);
    expect((await db.query('SELECT enabled,revision FROM brand_source WHERE brand_id=$1', [id])).rows).toEqual([{ enabled: true, revision: 1 }]);
    await db.query('UPDATE brand SET name=$2 WHERE id=$1', [id, name + ' changed']);
    await expect(importer.apply(out)).rejects.toThrow('BRAND_CHANGED');
  });
  it('rejects pending cleanup and ambiguous names before adding a Brand', async () => {
    const out = example(); out.cleanup.status = 'pending';
    await expect(importer.apply(out)).rejects.toThrow('EVIDENCE_UNVERIFIED');
    out.cleanup.status = 'closed'; await db.query('INSERT INTO brand(name) VALUES($1)', [out.seed!.name]);
    await expect(importer.apply(out)).rejects.toThrow('BRAND_NAME_CONFLICT');
    expect((await db.query('SELECT count(*)::int n FROM brand WHERE id=$1', [importedBrandId(out)])).rows[0].n).toBe(0);
  });
  it('does not bind a wrongly associated legacy company to a different actual product brand', async () => {
    const out = example(), id = randomUUID(); out.seed!.candidate.existingBrandIds = [id]; out.seed!.candidate.existingBrandNames = ['MaryRuth']; out.seed!.name = 'NaturesPlus';
    await expect(importer.apply(out)).rejects.toThrow('BRAND_NAME_REQUIRES_REVIEW');
  });
  it('uses only the existing Brand schema, leaving product/Temporal state absent', async () => {
    expect((await db.query("SELECT to_regnamespace('brand_entry') n,to_regclass('amazon_queue_item') q")).rows).toEqual([{ n: null, q: null }]);
  });
});
