import { isDeepStrictEqual } from 'node:util';
import { storeEntryUrl } from '../../../../packages/v3-channels/src/amazon-brand-entry.js';
import { type Outcome, type ObjectProof } from './contracts.js';

/** Bind the full publication to this attempt before reading any referenced object. */
export function verifiedProofs(out: Outcome): ObjectProof[] {
  const fail = () => { throw Error('BRAND_ENTRY.EVIDENCE_UNVERIFIED'); };
  const seed = out.seed;
  if (out.state !== 'verified' || !seed || !out.pages.length || !out.directories.length ||
      !out.verifiedAt || !out.directoryKind || out.cleanup.status !== 'closed' || !out.cleanup.targetIds.length) return fail();
  if (seed.campaignId !== out.campaignId || seed.candidateId !== out.candidateId || seed.candidate.companyId !== out.candidateId) return fail();
  const prefix = `v3/brand-entry/${out.campaignId}/${out.candidateId}/pages/`;
  const refs = new Map<string, ObjectProof>();
  for (const ref of out.evidence) {
    if (!ref.key.startsWith(prefix) || refs.has(ref.key)) return fail();
    refs.set(ref.key, ref);
  }
  for (const [i, page] of out.pages.entries()) {
    if (page.status !== 200) return fail();
    storeEntryUrl(page.requestedUrl); storeEntryUrl(page.finalUrl);
    for (const [kind, ref] of [['original.html', page.original], ['rendered.html', page.rendered], ['snapshot.txt', page.snapshot]] as const)
      if (ref.key !== `${prefix}${i}/${kind}` || !isDeepStrictEqual(refs.get(ref.key), ref)) return fail();
    if (!refs.has(`${prefix}${i}/original.json`)) return fail();
  }
  for (const directory of out.directories) {
    const page = out.pages[directory.pageIndex];
    if (!page || page.productCount < 1 || storeEntryUrl(page.finalUrl) !== storeEntryUrl(directory.url)) return fail();
  }
  return [seed.original, seed.receipt, ...out.evidence];
}
