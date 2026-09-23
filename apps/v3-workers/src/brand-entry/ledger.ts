import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type pg from 'pg';
import { CandidateSchema, CallSchema, OutcomeSchema, SeedSchema, type Call, type Candidate, type Outcome, type Seed } from './contracts.js';
import { storeEntryUrl } from '../../../../packages/v3-channels/src/amazon-brand-entry.js';

export const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export class BrandEntryLedger {
  constructor(readonly db: pg.Pool) {}
  private async transaction<T>(fn: (c: pg.PoolClient) => Promise<T>) {
    const c = await this.db.connect();
    try { await c.query('BEGIN'); await c.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'"); const result = await fn(c); await c.query('COMMIT'); return result; }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  async import(campaignId: string, raw: unknown[]) {
    const rows = raw.map(x => CandidateSchema.parse(x));
    if (new Set(rows.map(x => x.companyId)).size !== rows.length || !rows.length) throw Error('BRAND_ENTRY.MANIFEST');
    return this.transaction(async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,73110325))', [campaignId]);
      const prior = (await c.query('SELECT manifest_hash,total FROM brand_entry.campaign WHERE id=$1', [campaignId])).rows[0];
      if (prior) { if (prior.manifest_hash !== hash(rows) || prior.total !== rows.length) throw Error('BRAND_ENTRY.MANIFEST_CONFLICT'); return { total: rows.length, imported: false }; }
      await c.query('INSERT INTO brand_entry.campaign(id,manifest_hash,total) VALUES($1,$2,$3)', [campaignId, hash(rows), rows.length]);
      for (const [i, row] of rows.entries()) await c.query('INSERT INTO brand_entry.candidate(campaign_id,id,ordinal,input,input_hash) VALUES($1,$2,$3,$4,$5)', [campaignId, row.companyId, i, row, hash(row)]);
      return { total: rows.length, imported: true };
    });
  }
  async get(raw: Call) {
    const x = CallSchema.parse(raw), row = (await this.db.query('SELECT * FROM brand_entry.candidate WHERE campaign_id=$1 AND id=$2', [x.campaignId, x.candidateId])).rows[0];
    if (!row) throw Error('BRAND_ENTRY.CANDIDATE_MISSING');
    return { ...row, input: CandidateSchema.parse(row.input), seed: row.seed ? SeedSchema.parse(row.seed) : null, result: row.result ? OutcomeSchema.parse(row.result) : null };
  }
  async claim(x: Call, workflowId: string, runId: string) {
    await this.db.query("UPDATE brand_entry.candidate SET state='running',workflow_id=$3,run_id=$4,claimed_at=clock_timestamp() WHERE campaign_id=$1 AND id=$2 AND state='pending'", [x.campaignId, x.candidateId, workflowId, runId]);
    const row = await this.get(x);
    if (row.workflow_id !== workflowId || row.run_id !== runId) throw Error('BRAND_ENTRY.OWNER');
    return row;
  }
  async saveSeed(x: Call, seed: Seed) {
    await this.db.query('UPDATE brand_entry.candidate SET seed=$3 WHERE campaign_id=$1 AND id=$2 AND seed IS NULL AND state=\'running\'', [x.campaignId, x.candidateId, SeedSchema.parse(seed)]);
    if (!isDeepStrictEqual((await this.get(x)).seed, seed)) throw Error('BRAND_ENTRY.SEED_CONFLICT');
  }
  async saveFetchJob(x: Call, job: unknown) {
    await this.db.query("UPDATE brand_entry.candidate SET fetch_job=$3 WHERE campaign_id=$1 AND id=$2 AND fetch_job IS NULL AND state='running'", [x.campaignId, x.candidateId, job]);
    if (!isDeepStrictEqual((await this.get(x)).fetch_job, job)) throw Error('BRAND_ENTRY.FETCH_CONFLICT');
  }
  async finish(raw: Outcome) {
    const out = OutcomeSchema.parse(raw);
    if (out.state === 'verified' && (out.cleanup.status !== 'closed' || !out.seed || !out.directories.length || !out.directoryKind || !out.verifiedAt)) throw Error('BRAND_ENTRY.RESULT_UNVERIFIED');
    return this.transaction(async c => {
      const row = (await c.query('SELECT * FROM brand_entry.candidate WHERE campaign_id=$1 AND id=$2 FOR UPDATE', [out.campaignId, out.candidateId])).rows[0];
      if (!row) throw Error('BRAND_ENTRY.CANDIDATE_MISSING');
      if (row.result) { if (!isDeepStrictEqual(row.result, out)) throw Error('BRAND_ENTRY.RESULT_CONFLICT'); return row.result as Outcome; }
      if (row.state !== 'running') throw Error('BRAND_ENTRY.OWNER');
      const candidate = CandidateSchema.parse(row.input);
      if (out.seed && !isDeepStrictEqual(row.seed, out.seed)) throw Error('BRAND_ENTRY.SEED_CONFLICT');
      if (out.state === 'verified') {
        const seed = out.seed!;
        let brandId: string;
        if (candidate.existingBrandIds.length > 1) throw Error('BRAND_ENTRY.BRAND_IDENTITY_AMBIGUOUS');
        if (candidate.existingBrandIds.length === 1) {
          brandId = candidate.existingBrandIds[0]!;
          if (!(await c.query('SELECT 1 FROM public.brand WHERE id=$1 FOR UPDATE', [brandId])).rowCount) throw Error('BRAND_ENTRY.BRAND_MISSING');
        } else {
          await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,73110325))', [seed.name.toLowerCase()]);
          const same = (await c.query('SELECT id FROM public.brand WHERE lower(name)=lower($1)', [seed.name])).rows;
          // Same spelling alone does not prove a historical-company identity match.
          if (same.length) throw Error('BRAND_ENTRY.BRAND_NAME_CONFLICT');
          brandId = randomUUID();
          await c.query('INSERT INTO public.brand(id,name,note) VALUES($1,$2,$3)', [brandId, seed.name, `Amazon product-to-store evidence; legacy company ${candidate.companyId}; preparation ${out.campaignId}`]);
        }
        const ids: string[] = [];
        for (const entry of out.directories) {
          const url = storeEntryUrl(entry.url);
          const page = out.pages[entry.pageIndex];
          if (!page || storeEntryUrl(page.finalUrl) !== url || page.productCount < 1) throw Error('BRAND_ENTRY.DIRECTORY_UNVERIFIED');
          await c.query('INSERT INTO public.brand_source(brand_id,channel,region,url,enabled) VALUES($1,\'amazon\',\'US\',$2,false) ON CONFLICT (brand_id,region,url) DO NOTHING', [brandId, url]);
          const source = (await c.query('SELECT id,channel FROM public.brand_source WHERE brand_id=$1 AND region=\'US\' AND url=$2', [brandId, url])).rows[0];
          if (!source || source.channel !== 'amazon') throw Error('BRAND_ENTRY.SOURCE_CONFLICT');
          ids.push(source.id);
        }
        await c.query('INSERT INTO brand_entry.mapping(campaign_id,candidate_id,brand_id,source_ids,result_hash) VALUES($1,$2,$3,$4,$5)', [out.campaignId, out.candidateId, brandId, ids, hash(out)]);
      }
      await c.query('UPDATE brand_entry.candidate SET state=$3,result=$4,finished_at=clock_timestamp() WHERE campaign_id=$1 AND id=$2', [out.campaignId, out.candidateId, out.state, out]);
      return out;
    });
  }
  async pending(campaignId: string, limit: number, selection: string[] = []) {
    return (await this.db.query("SELECT id FROM brand_entry.candidate WHERE campaign_id=$1 AND state='pending' AND (cardinality($3::uuid[])=0 OR id=ANY($3::uuid[])) ORDER BY ordinal LIMIT $2", [campaignId, limit, selection])).rows.map(x => x.id as string);
  }
  async status(campaignId: string) { return (await this.db.query('SELECT state,count(*)::int count FROM brand_entry.candidate WHERE campaign_id=$1 GROUP BY state ORDER BY state', [campaignId])).rows; }
}
