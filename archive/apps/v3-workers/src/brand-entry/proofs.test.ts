import { describe, it, expect } from 'vitest';
import { verifiedProofs } from './proofs.js';
import { baseOutcome, type ObjectProof, type Outcome } from './contracts.js';

function example(): Outcome {
  const call = { campaignId: '11111111-1111-4111-8111-111111111111', candidateId: '22222222-2222-4222-8222-222222222222' };
  const url = 'https://www.amazon.com/stores/Example/page/33333333-3333-4333-8333-333333333333';
  const ref = (key: string): ObjectProof => ({ key, sha256: 'a'.repeat(64), byteSize: 20, mediaType: 'text/html' });
  const prefix = `v3/brand-entry/${call.campaignId}/${call.candidateId}/pages/0/`;
  const refs = ['original.html', 'original.json', 'rendered.html', 'snapshot.txt'].map(x => ref(prefix + x));
  const out = baseOutcome(call, 'verified', 'BRAND_ENTRY.VERIFIED');
  out.seed = { ...call, candidate: { companyId: call.candidateId, name: 'Example', nameVariants: [], databases: ['legacy'],
    existingBrandIds: [], existingBrandNames: [], sampleUrl: 'https://www.amazon.com/dp/B000000001', missingFromPreviousBrandList: true,
    amazonListings: [{ site: 'amazon.com', asin: 'B000000001' }] }, asin: 'B000000001', productUrl: 'https://www.amazon.com/dp/B000000001',
    name: 'Example', brandRaw: 'Visit the Example Store', storeUrl: url, capturedAt: '2026-09-20T00:00:00.000Z', original: ref('seed/original.html'), receipt: ref('seed/original.json') };
  out.pages = [{ requestedUrl: url, finalUrl: url, capturedAt: '2026-09-23T00:00:00.000Z', status: 200, original: refs[0]!, rendered: refs[2]!, snapshot: refs[3]!,
    responseRepresentation: 'fetch-response-base64', title: 'Example', productCount: 5 }];
  out.evidence = refs; out.directories = [{ url, text: 'Shop All', pageIndex: 0 }]; out.directoryKind = 'all_products';
  out.cleanup = { status: 'closed', targetIds: ['task-owned-target'], checkedAt: '2026-09-23T00:00:01.000Z' }; out.verifiedAt = '2026-09-23T00:00:00.000Z';
  return out;
}
describe('Brand publication evidence boundary', () => {
  it('requires every page and both seed objects while retaining the old seed timestamp', () => {
    const out = example(); expect(verifiedProofs(out)).toHaveLength(6); expect(out.seed!.capturedAt).toBe('2026-09-20T00:00:00.000Z');
  });
  it.each(['empty', 'omitted', 'foreign', 'changed', 'duplicate', 'receipt', 'unclosed', 'empty-directory', 'wrong-candidate'])(
    'rejects %s evidence before publication', variant => {
      const out = example();
      if (variant === 'empty') out.evidence = [];
      if (variant === 'omitted') out.evidence = out.evidence.filter(x => x !== out.pages[0]!.rendered);
      if (variant === 'foreign') out.pages[0]!.original.key = 'another-task/original.html';
      if (variant === 'changed') out.pages[0]!.original = { ...out.pages[0]!.original, sha256: 'b'.repeat(64) };
      if (variant === 'duplicate') out.evidence.push(out.evidence[0]!);
      if (variant === 'receipt') out.evidence = out.evidence.filter(x => !x.key.endsWith('original.json'));
      if (variant === 'unclosed') out.cleanup.status = 'pending';
      if (variant === 'empty-directory') out.pages[0]!.productCount = 0;
      if (variant === 'wrong-candidate') out.seed!.candidate.companyId = out.campaignId;
      expect(() => verifiedProofs(out)).toThrow('EVIDENCE_UNVERIFIED');
    });
});
