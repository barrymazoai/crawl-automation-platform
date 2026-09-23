import { z } from 'zod';

export const CandidateSchema = z.object({
  companyId: z.uuid(), name: z.string().min(1).max(4000), nameVariants: z.array(z.string()),
  databases: z.array(z.string()), existingBrandIds: z.array(z.uuid()),
  existingBrandNames: z.array(z.string()), sampleUrl: z.url(), missingFromPreviousBrandList: z.boolean(),
  amazonListings: z.array(z.strictObject({ site: z.literal('amazon.com'), asin: z.string().regex(/^[A-Z0-9]{10}$/) })).min(1).max(10000),
});
export type Candidate = z.infer<typeof CandidateSchema>;
export const CallSchema = z.strictObject({ campaignId: z.uuid(), candidateId: z.uuid() });
export type Call = z.infer<typeof CallSchema>;
export const ObjectProofSchema = z.strictObject({ key: z.string().min(1).max(1000), sha256: z.string().regex(/^[a-f0-9]{64}$/), byteSize: z.number().int().positive(), mediaType: z.string() });
export type ObjectProof = z.infer<typeof ObjectProofSchema>;
export const SeedSchema = z.strictObject({
  ...CallSchema.shape, candidate: CandidateSchema, asin: z.string().regex(/^[A-Z0-9]{10}$/), productUrl: z.url(),
  name: z.string().min(1).max(80), brandRaw: z.string(), storeUrl: z.url(),
  capturedAt: z.iso.datetime(), original: ObjectProofSchema, receipt: ObjectProofSchema,
});
export type Seed = z.infer<typeof SeedSchema>;
export const PageProofSchema = z.strictObject({
  requestedUrl: z.url(), finalUrl: z.url(), capturedAt: z.iso.datetime(), status: z.number().int(),
  original: ObjectProofSchema, rendered: ObjectProofSchema, snapshot: ObjectProofSchema,
  responseRepresentation: z.literal('fetch-response-base64'), title: z.string(), productCount: z.number().int().nonnegative(),
});
export const OutcomeSchema = z.strictObject({
  ...CallSchema.shape, state: z.enum(['verified', 'review', 'failed', 'cancelled']), code: z.string(),
  seed: SeedSchema.nullable(), pages: z.array(PageProofSchema).max(8),
  evidence: z.array(ObjectProofSchema).max(64),
  directories: z.array(z.strictObject({ url: z.url(), text: z.string(), pageIndex: z.number().int().min(0).max(7) })).max(7),
  directoryKind: z.enum(['all_products', 'category_set']).nullable(), catalogEnumerationComplete: z.literal(false),
  cleanup: z.strictObject({ status: z.enum(['not_opened', 'closed', 'pending']), targetIds: z.array(z.string()), checkedAt: z.iso.datetime() }),
  verifiedAt: z.iso.datetime().nullable(),
});
export type Outcome = z.infer<typeof OutcomeSchema>;
export const CONTROL_QUEUE = 'amazon-brand-entry-control';
export const BROWSER_QUEUE = 'amazon-brand-entry-browser';
export const workflowId = (x: Call) => `brand-entry-${x.campaignId}-${x.candidateId}`;
export const safeCode = (e: unknown) => e instanceof Error && /^(?:BRAND_ENTRY|AMAZON|ARTIFACT|RESOURCE|NETWORK|SCRAPERAPI)\.[A-Z_]+$/.test(e.message) ? e.message : 'BRAND_ENTRY.EXECUTION_UNRESOLVED';
export const baseOutcome = (x: Call, state: Outcome['state'], code: string): Outcome => ({ ...x, state, code, seed: null, pages: [], evidence: [], directories: [], directoryKind: null, catalogEnumerationComplete: false, cleanup: { status: 'not_opened', targetIds: [], checkedAt: new Date().toISOString() }, verifiedAt: null });
