import { z } from "zod";

const nullableString = z.string().nullable();
const image = z.looseObject({
  clientRef: z.string(),
  url: z.string(),
  imageId: nullableString,
});
const identity = z.looseObject({
  familyId: nullableString,
  variantKey: nullableString,
  state: z.string(),
  confidence: z.number(),
  reasons: z.array(z.string()),
  reviewId: nullableString,
});
const failure = z.looseObject({ code: z.string(), message: z.string() }).nullable();

export const ProductIngestItemResultSchema = z.looseObject({
  clientRef: z.string(),
  status: z.enum(["ok", "failed"]),
  productId: nullableString,
  listingId: nullableString,
  companyId: nullableString,
  matchedBy: nullableString,
  identity: identity.nullable(),
  observation: z.looseObject({ listingId: z.string() }).nullable(),
  observationSkipped: nullableString,
  facts: z.looseObject({
    formulaId: z.string(),
    factsHash: z.string(),
    observationInserted: z.boolean(),
  }).nullable(),
  images: z.array(image),
  error: failure,
});
export const ProductIngestBatchAnswerSchema = z.looseObject({
  runId: z.string(),
  crawlRunId: z.string(),
  counts: z.looseObject({
    received: z.number(), ok: z.number(), failed: z.number(),
    created: z.number(), matched: z.number(), needsReview: z.number(),
  }),
  results: z.array(ProductIngestItemResultSchema),
});
export const ProductVerifyItemSchema = z.looseObject({
  clientRef: z.string(),
  recorded: z.boolean(),
  ledger: z.looseObject({
    status: z.enum(["ok", "failed"]),
    matchedBy: nullableString,
    identityState: nullableString,
    variantKey: nullableString,
    error: z.unknown().nullable(),
  }).nullable(),
  product: z.looseObject({
    id: z.string(), familyId: nullableString, variantKey: nullableString,
    identityState: z.string(), formulaId: nullableString, gtin: nullableString,
  }).nullable(),
  listing: z.looseObject({
    id: z.string(), status: z.string(), firstSeenAt: nullableString,
    lastSeenAt: nullableString, latestSnapshotAt: nullableString,
    latestPrice: nullableString, latestCurrency: nullableString, imageCount: z.number(),
  }).nullable(),
  latestFormulaHash: nullableString,
  mismatches: z.array(z.looseObject({ field: z.string(), expected: z.unknown(), actual: z.unknown() })),
  problems: z.array(z.string()),
});
export const ProductVerifyBatchAnswerSchema = z.looseObject({
  runId: z.string(), found: z.boolean(),
  run: z.looseObject({
    status: z.string(), scope: z.string(), itemsReceived: z.number(),
    itemsOk: z.number(), itemsFailed: z.number(), itemsNeedsReview: z.number(),
  }).nullable(),
  verified: z.number(), expected: z.number(),
  items: z.array(ProductVerifyItemSchema), problems: z.array(z.string()), readbackHash: z.string(),
});
export const ProductCompleteRunAnswerSchema = z.looseObject({
  runId: z.string(), found: z.boolean(), replayed: z.boolean(),
  scope: z.enum(["full", "partial"]).nullable(), status: nullableString,
  deactivated: z.number(), deactivatedListingIds: z.array(z.string()), problems: z.array(z.string()),
});
export const ProductLabelIngestAnswerSchema = z.looseObject({
  outcome: z.enum(["created", "replayed", "in_progress", "conflict", "failed"]),
  operationId: z.string(), ingestRequestId: nullableString, requestFingerprint: z.string(),
  labelObservationId: nullableString, labelHash: nullableString,
  productId: nullableString, listingId: nullableString, companyId: nullableString,
  company: z.looseObject({
    status: z.enum(["matched", "unmatched", "ambiguous", "conflict"]),
    domain: z.string(), companyId: nullableString, companyName: nullableString,
    matchedBy: nullableString, candidates: z.array(z.looseObject({
      id: z.string(), name: z.string(), website: nullableString, stage: z.string(),
    })), expectedCompanyId: nullableString, reason: z.string(),
  }).nullable(),
  matchedBy: nullableString, identity: identity.nullable(),
  normalization: z.looseObject({
    version: z.string(), status: z.enum(["normalized", "partial", "unnormalized"]),
    issues: z.array(z.string()), formulaId: nullableString, factsHash: nullableString,
    semanticHash: nullableString, semanticHashVersion: nullableString,
    eligibleForIdentity: z.boolean(), formulaObservationInserted: z.boolean(),
    materialized: z.boolean(), hasDoseEvidence: z.boolean(), columns: z.number().int(), rows: z.number().int(),
  }).nullable(),
  images: z.array(image),
  steps: z.looseObject({
    request: z.enum(["claimed", "replayed", "in_progress", "conflict"]),
    company: z.enum(["matched", "unmatched", "ambiguous", "conflict", "skipped"]),
    product: z.enum(["done", "failed", "skipped"]),
    labelObservation: z.enum(["done", "failed", "skipped"]),
    formula: z.enum(["done", "failed", "skipped", "none"]),
  }),
  error: failure,
});
export const ProductLabelReadAnswerSchema = z.looseObject({
  found: z.boolean(),
  request: z.looseObject({
    id: z.string(), state: z.enum(["started", "completed", "failed"]), fingerprint: z.string(),
    startedAt: z.string(), finishedAt: nullableString, attempts: z.number().int(), error: z.unknown().nullable(),
  }).nullable(),
  observation: z.looseObject({
    id: z.string(), submitterNamespace: z.string(), externalObservationId: z.string(), operationId: z.string(),
    productId: z.string(), listingId: nullableString, label: z.unknown(),
    labelHash: z.string(), requestFingerprint: z.string(),
  }).nullable(),
  matches: z.looseObject({ labelHash: z.boolean().nullable(), requestFingerprint: z.boolean().nullable() }),
  problems: z.array(z.string()),
});
export type ProductIngestBatchAnswer = z.infer<typeof ProductIngestBatchAnswerSchema>;
export type ProductVerifyBatchAnswer = z.infer<typeof ProductVerifyBatchAnswerSchema>;
export type ProductCompleteRunAnswer = z.infer<typeof ProductCompleteRunAnswerSchema>;
export type ProductLabelIngestAnswer = z.infer<typeof ProductLabelIngestAnswerSchema>;
export type ProductLabelReadAnswer = z.infer<typeof ProductLabelReadAnswerSchema>;
