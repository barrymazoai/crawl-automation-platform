import type pg from 'pg';
import { AmazonProductJobSchema, type AmazonProductJob } from '@crawl-automation/v3-contracts';
import { RetainedPublication, sha256 } from '@crawl-automation/v3-artifacts';
import { createHttpRoute } from '@crawl-automation/v3-acquisition';
import { AmazonHtmlArchive, AmazonHttpReader } from '@crawl-automation/v3-channels';
import { PostgresAmazonHtmlFetchGate } from '../amazon-html-fetch.js';
import { PostgresResourceAdmission } from '../../../../packages/v3-product/src/resource-admission.js';
import { seedBrand } from '../../../../packages/v3-channels/src/amazon-brand-entry.js';
import type { AmazonLiveConfig } from '../amazon-live-config.js';
import { BrandEntryLedger, hash } from './ledger.js';
import { SeedSchema, type Call, type Candidate, type ObjectProof, type Seed } from './contracts.js';

const proof = (key: string, bytes: Uint8Array, mediaType: string): ObjectProof => ({ key, sha256: sha256(bytes), byteSize: bytes.length, mediaType });
export class BrandEntrySeeds {
  private readonly admission: PostgresResourceAdmission;
  constructor(private readonly db: pg.Pool, private readonly ledger: BrandEntryLedger,
    private readonly publication: RetainedPublication, private readonly config: AmazonLiveConfig) { this.admission = new PostgresResourceAdmission(db); }
  private permit(x: Call, owner: { workflowId: string; runId: string }) {
    return { permitId: `brand-seed-${hash(x)}`, ...owner, needs: [{ resourceId: this.config.browserResource, units: 1 }] };
  }
  async release(x: Call, owner: { workflowId: string; runId: string }) {
    const request = this.permit(x, owner), held = await this.admission.read(request.permitId);
    if (held && !held.released) await this.admission.release(request);
  }
  private async fetchJob(x: Call, candidate: Candidate, asin: string) {
    // Evidence for a previously unconfigured company is owned by the existing
    // explicitly-unassigned Amazon scope. This is not a company-to-Brand mapping.
    const rows = (await this.db.query(`SELECT b.id brand_id,b.name,s.id source_id,s.url,s.revision FROM public.brand b
      JOIN public.brand_source s ON s.brand_id=b.id AND s.channel='amazon' AND s.region='US'
      WHERE b.id=ANY($1::uuid[]) OR b.name='Amazon 未分组（旧库无公司）'
      ORDER BY CASE WHEN b.id=ANY($1::uuid[]) THEN 0 ELSE 1 END,s.created_at LIMIT 1`, [candidate.existingBrandIds])).rows;
    const scopeRow = rows[0]; if (!scopeRow) throw Error('BRAND_ENTRY.SEED_SCOPE_MISSING');
    const identity = hash(x), operationId = `brand-entry-seed-${identity}`, bytes = Buffer.from(JSON.stringify({ codec: 'brand-entry-seed-intent/1', ...x, candidate, asin }));
    const key = `v3/brand-entry/${x.campaignId}/${x.candidateId}/seed-intent.json`;
    await this.publication.publish(key, bytes, 'application/json', AbortSignal.timeout(20000));
    const scope = { brandId: scopeRow.brand_id, sourceId: scopeRow.source_id, channel: 'amazon', region: 'US', rootUrl: scopeRow.url, scopeVersion: `source-revision-${scopeRow.revision}` };
    return AmazonProductJobSchema.parse({ codec: 'amazon-product-job/1', operationId, sessionId: `brand-entry-page-${identity}`,
      discovery: { discoveryId: `brand-entry-discovery-${identity}`, catalogId: `brand-entry-${x.campaignId}`, workflowId: `brand-entry-seed-${identity}`, scope,
        entry: { kind: 'product', listingId: asin, variantId: null, url: `https://www.amazon.com/dp/${asin}` },
        source: { schemaVersion: 1, artifactId: `brand-entry-intent-${identity}`, observationId: operationId, sourceId: scopeRow.source_id,
          listingId: asin, variantId: null, kind: 'result-json', mediaType: 'application/json', objectKey: key, byteSize: bytes.length, sha256: sha256(bytes),
          producer: { operationId, module: 'amazon.brand-entry', implementationVersion: 'brand-entry/1' } } },
      queues: this.config.productQueues, resources: this.config.productResources, stopAfter: 'observation' });
  }
  async prepare(x: Call, owner: { workflowId: string; runId: string }, signal: AbortSignal): Promise<{ status: 'ready'; seed: Seed } | { status: 'waiting' }> {
    const row = await this.ledger.get(x), candidate: Candidate = row.input;
    if (row.result) throw Error('BRAND_ENTRY.TERMINAL');
    if (row.seed) return { status: 'ready', seed: row.seed };
    if (candidate.existingBrandIds.length > 1) throw Error('BRAND_ENTRY.BRAND_IDENTITY_AMBIGUOUS');
    let job: AmazonProductJob;
    const prior = (await this.db.query(`SELECT job FROM amazon_html_fetch WHERE site='https://www.amazon.com'
      AND asin=ANY($1::text[]) AND captured_at IS NOT NULL ORDER BY captured_at DESC LIMIT 1`, [candidate.amazonListings.map(x => x.asin)])).rows[0];
    if (prior) job = AmazonProductJobSchema.parse(prior.job);
    else {
      const request = this.permit(x, owner), decision = await this.admission.reserve(request);
      if (decision.status === 'waiting') return { status: 'waiting' };
      if (decision.status !== 'granted') throw Error('BRAND_ENTRY.SEED_ALREADY_ATTEMPTED');
      try {
        if (row.fetch_job) throw Error('BRAND_ENTRY.SEED_ALREADY_ATTEMPTED');
        job = await this.fetchJob(x, candidate, candidate.amazonListings[0]!.asin);
        await this.ledger.saveFetchJob(x, job);
        if (this.config.capture.mode !== 'scraperapi') throw Error('BRAND_ENTRY.CAPTURE_CONFIG');
        const route = createHttpRoute(this.config.capture.route, { scraperApi: this.config.capture.scraperApi });
        const gate = new PostgresAmazonHtmlFetchGate(this.db, (j, s) => new AmazonHtmlArchive(this.publication, j).inspect(s));
        await new AmazonHttpReader(route, undefined, gate).originalProduct(job.discovery.entry.url, signal, new AmazonHtmlArchive(this.publication, job));
      } finally { await this.release(x, owner); }
    }
    const archive = new AmazonHtmlArchive(this.publication, job), saved = await archive.inspect(signal);
    if (!saved) throw Error('BRAND_ENTRY.ORIGINAL_MISSING');
    const receiptKey = `${archive.prefix}/original.json`, receipt = await this.publication.remote.read(receiptKey, 65536, signal);
    if (!receipt) throw Error('BRAND_ENTRY.ORIGINAL_MISSING');
    const asin = job.discovery.entry.listingId, url = job.discovery.entry.url;
    if (!candidate.amazonListings.some(x => x.asin === asin)) throw Error('BRAND_ENTRY.SEED_IDENTITY');
    const parsed = seedBrand(new TextDecoder('utf-8', { fatal: true }).decode(saved.bytes), asin, url);
    const seed = SeedSchema.parse({ ...x, candidate, asin, productUrl: url, ...parsed, capturedAt: saved.capturedAt,
      original: { key: saved.source.objectKey, sha256: saved.source.sha256, byteSize: saved.source.byteSize, mediaType: 'text/html' },
      receipt: proof(receiptKey, receipt, 'application/json') });
    await this.ledger.saveSeed(x, seed);
    return { status: 'ready', seed };
  }
}
