// Brand scan -> product queue input (amazon-link-batch/1). Pure; used by scripts/prepare-brand-scan-queue.mjs.
import { createHash, randomUUID } from 'node:crypto';
const sha = s => createHash('sha256').update(s).digest('hex');
// Same identity as the product history store (apps/v3-api/src/history/model.ts identifyListing + canonical JSON).
export const historyListingId = asin => sha(`{"channel":"amazon","externalId":"${asin}","site":"amazon.com"}`);
export const candidateId = (campaign, asin) => sha(JSON.stringify([campaign, asin]));
// candidates: [{ asin, scope }]. One batch holds at most 10 products of one scope (the queue splits them per product).
export function linkBatches(campaign, candidates, candidateManifestSha256, newId = randomUUID) {
  const byScope = new Map();
  for (const c of candidates) {
    if (!/^[A-Z0-9]{10}$/.test(c.asin)) throw Error('BRAND_SCAN.ASIN');
    const k = JSON.stringify(c.scope); if (!byScope.has(k)) byScope.set(k, []); byScope.get(k).push(c);
  }
  const batches = [];
  for (const list of byScope.values()) for (let i = 0; i < list.length; i += 10) {
    const part = list.slice(i, i + 10);
    batches.push({ codec: 'amazon-link-batch/1', requestId: newId(), scope: part[0].scope, candidateManifestSha256,
      entries: part.map(c => ({ entry: { url: `https://www.amazon.com/dp/${c.asin}`, kind: 'product', listingId: c.asin, variantId: null },
        candidateId: candidateId(campaign, c.asin), historyListingId: historyListingId(c.asin) })) });
  }
  return batches;
}
