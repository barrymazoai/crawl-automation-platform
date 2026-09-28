import { describe, it, expect } from 'vitest';
import { AmazonLinkBatchSchema } from '../amazon-link-batches.js';
import { identifyListing } from '../../../v3-api/src/history/model.js';
import { historyListingId, candidateId, linkBatches } from './scan-queue.mjs';

const scope = (brandId: string) => ({ brandId, sourceId: '22222222-2222-4222-8222-222222222222', channel: 'amazon' as const,
  region: 'US', rootUrl: 'https://www.amazon.com/', scopeVersion: 'source-revision-3' });
let n = 0; const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

describe('brand scan queue input', () => {
  it('history listing id equals the product history store identity', () => {
    for (const asin of ['B0096M5PBW', 'B0H85M8XH6'])
      expect(historyListingId(asin)).toBe(identifyListing({ channel: 'amazon', external_id: asin, product_url: `https://www.amazon.com/dp/${asin}` }, 'd', 'k').id);
  });
  it('builds queue batches the Amazon queue accepts: at most 10 products, one scope per batch', () => {
    const a = scope('11111111-1111-4111-8111-111111111111'), b = scope('33333333-3333-4333-8333-333333333333');
    const asins = Array.from({ length: 23 }, (_, i) => `B0${String(i).padStart(8, '0')}`);
    const batches = linkBatches('amazon-brand-scan-test', [...asins.map(asin => ({ asin, scope: a })), { asin: 'B0ZZZZZZZZ', scope: b }], 'f'.repeat(64), id);
    expect(batches.map(x => x.entries.length)).toEqual([10, 10, 3, 1]);
    for (const batch of batches) expect(() => AmazonLinkBatchSchema.parse(batch)).not.toThrow();
    expect(batches[3]!.scope).toEqual(b);
    const e = batches[0]!.entries[0]!;
    expect(e).toEqual({ entry: { url: 'https://www.amazon.com/dp/B000000000', kind: 'product', listingId: 'B000000000', variantId: null },
      candidateId: candidateId('amazon-brand-scan-test', 'B000000000'), historyListingId: historyListingId('B000000000') });
  });
  it('rejects anything that is not an ASIN', () => {
    expect(() => linkBatches('c', [{ asin: 'b0lowercase', scope: scope('11111111-1111-4111-8111-111111111111') }], 'f'.repeat(64), id)).toThrow(/ASIN/);
  });
});
