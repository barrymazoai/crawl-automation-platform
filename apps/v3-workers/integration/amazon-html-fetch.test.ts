import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import pg from 'pg';
import { PostgresAmazonHtmlFetchGate } from '../src/amazon-html-fetch.js';
import { amazonFixture } from '../../../packages/v3-channels/src/amazon-live.fixture.js';

const address = process.env.V3_HTML_FETCH_TEST_URL, signal = () => AbortSignal.timeout(15000);
describe.skipIf(!address)('Mini atomic rolling HTML fetch admission', () => {
  let db: pg.Pool, gate: PostgresAmazonHtmlFetchGate;
  beforeAll(async () => {
    if (!/Mac-mini/i.test(hostname()) || process.env.V3_HTML_FETCH_ISOLATED !== 'true') throw Error('Isolated Mac mini database required');
    db = new pg.Pool({ connectionString: address, max: 12 });
    if ((await db.query('SELECT current_database() name')).rows[0].name !== 'crawler_v3_test' ||
      (await db.query("SELECT to_regclass('amazon_html_fetch') t")).rows[0].t) throw Error('Empty isolated database required');
    await db.query(await readFile(`${process.env.V3_HISTORY_SQL_ROOT}/024_amazon_html_fetch.sql`, 'utf8'));
    gate = new PostgresAmazonHtmlFetchGate(db);
  });
  afterAll(async () => { await db?.end(); });
  async function job(id: string, asin: string) {
    const j = await amazonFixture().job(); j.operationId = `capture-${id}`; j.sessionId = `page-${id}`;
    j.discovery.discoveryId += id; j.discovery.entry.listingId = asin; j.discovery.entry.url = `https://www.amazon.com/dp/${asin}`;
    return j;
  }
  it('serializes 12 concurrent campaigns for the same ASIN into exactly one download', async () => {
    const jobs = await Promise.all(Array.from({ length: 12 }, (_, i) => job(`concurrent-${i}`, 'B000000001')));
    const decisions = await Promise.all(jobs.map(j => gate.acquire(j, signal())));
    expect(decisions.filter(d => d.kind === 'download')).toHaveLength(1);
    expect(decisions.filter(d => d.kind === 'reuse')).toHaveLength(11);
    expect((await db.query("SELECT count(*)::int n FROM amazon_html_fetch WHERE asin='B000000001'")).rows[0].n).toBe(1);
    const winner = jobs[decisions.findIndex(d => d.kind === 'download')]!;
    await expect(gate.acquire(winner, signal())).rejects.toThrow('DOWNLOAD_UNRESOLVED');
  });
  it('a failed or unknown request blocks other tasks throughout the rolling window', async () => {
    const first = await job('unknown', 'B000000002'); await gate.acquire(first, signal());
    expect(await gate.acquire(await job('unknown-new', 'B000000002'), signal())).toEqual({ kind: 'reuse', job: first });
    expect((await db.query('SELECT captured_at FROM amazon_html_fetch WHERE operation_id=$1', [first.operationId])).rows[0].captured_at).toBeNull();
  });
  it('retains the original timestamp after multiple reuses and rejects receipt mutation', async () => {
    const first = await job('complete', 'B000000003'); await gate.acquire(first, signal());
    const at = new Date().toISOString(); await gate.complete(first, at, signal()); await gate.complete(first, at, signal());
    expect(await gate.acquire(await job('complete-new', 'B000000003'), signal())).toEqual({ kind: 'reuse', job: first });
    await expect(gate.complete(first, new Date(Date.parse(at) + 1000).toISOString(), signal())).rejects.toThrow('RECEIPT_CONFLICT');
    const altered = structuredClone(first); altered.discovery.scope.brandId += '-different';
    await expect(gate.complete(altered, at, signal())).rejects.toThrow('RECEIPT_CONFLICT');
    expect((await db.query('SELECT captured_at FROM amazon_html_fetch WHERE operation_id=$1', [first.operationId])).rows[0].captured_at.toISOString()).toBe(at);
  });
  it('uses a rolling window across midnight; a new task may fetch after 24 hours, the old task cannot', async () => {
    const fresh = await job('near-expiry', 'B000000004'), expired = await job('expired', 'B000000005');
    for (const [j, age] of [[fresh, '23 hours 59 minutes'], [expired, '24 hours 1 minute']] as const)
      await db.query("INSERT INTO amazon_html_fetch(operation_id,site,asin,job,requested_at) VALUES($1,'https://www.amazon.com',$2,$3,clock_timestamp()-$4::interval)", [j.operationId, j.discovery.entry.listingId, j, age]);
    expect(await gate.acquire(await job('near-new', 'B000000004'), signal())).toEqual({ kind: 'reuse', job: fresh });
    await expect(gate.acquire(expired, signal())).rejects.toThrow('DOWNLOAD_UNRESOLVED');
    expect(await gate.acquire(await job('expired-new', 'B000000005'), signal())).toEqual({ kind: 'download' });
  });
  it('measures successful archives from original capture, not request start or later reuse', async () => {
    const first = await job('slow-capture', 'B000000006');
    await db.query("INSERT INTO amazon_html_fetch(operation_id,site,asin,job,requested_at,captured_at) VALUES($1,'https://www.amazon.com',$2,$3,clock_timestamp()-interval '24 hours 1 minute',clock_timestamp()-interval '23 hours 59 minutes')", [first.operationId, first.discovery.entry.listingId, first]);
    expect(await gate.acquire(await job('slow-new', 'B000000006'), signal())).toEqual({ kind: 'reuse', job: first });
  });
  it('different ASINs do not block each other; cancellation cannot open admission', async () => {
    expect(await gate.acquire(await job('independent', 'B000000007'), signal())).toEqual({ kind: 'download' });
    const j = await job('aborted', 'B000000008');
    await expect(gate.acquire(j, AbortSignal.abort())).rejects.toThrow();
    expect((await db.query('SELECT count(*)::int n FROM amazon_html_fetch WHERE operation_id=$1', [j.operationId])).rows[0].n).toBe(0);
  });
});
