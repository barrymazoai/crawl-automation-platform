import { z } from "zod";

/**
 * KAN-243 (owner 2026-11-05; Supply Smart contract v2.3, docs/product-db-v2/07-crawler-ingest-contract.md §2.2.1):
 * whether a listing and the same ASIN's listing on another storefront are one product. It travels on the
 * observation batch item only (never in a label request) and acts only when Supply Smart first creates the listing.
 * A rule only ever says `same`; anything else is the model's judgment.
 */
export const CrossMarketVerdictSchema = z.enum(["same", "different", "unsure"]);
export type CrossMarketVerdict = z.infer<typeof CrossMarketVerdictSchema>;

export const CrossMarketFieldSchema = z
  .strictObject({
    verdict: CrossMarketVerdictSchema,
    comparedWith: z.strictObject({
      listingId: z.string().min(1).max(200),
      countryCode: z.string().regex(/^[A-Z]{2}$/u),
      externalId: z.string().min(1).max(200),
    }),
    method: z.enum(["rule", "codex"]),
    model: z.string().min(1).max(200).optional(),
    reasons: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u)).max(20).optional(),
    decidedAt: z.iso.datetime({ offset: true }),
  })
  .refine((field) => field.method !== "rule" || field.verdict === "same", {
    message: "a rule only ever says same",
  })
  .refine((field) => field.method !== "codex" || !!field.model, {
    message: "a model's judgment names the model",
  });
export type CrossMarketField = z.infer<typeof CrossMarketFieldSchema>;

/** One listing of `product.getCrossMarketListings`, as Supply Smart returns it (fields we read). */
export const CrossMarketListingSchema = z.looseObject({
  listingId: z.string(),
  productId: z.string(),
  countryCode: z.string(),
  marketplace: z.string().nullable(),
  status: z.string(),
  latestLabel: z
    .looseObject({
      labelObservationId: z.string(),
      submitterNamespace: z.string(),
      externalObservationId: z.string(),
      semanticHash: z.string().nullable(),
      eligibleForIdentity: z.boolean(),
    })
    .nullable(),
});
export type CrossMarketListing = z.infer<typeof CrossMarketListingSchema>;

export const CrossMarketListingsAnswerSchema = z.looseObject({
  results: z.array(
    z.looseObject({ externalId: z.string(), listings: z.array(CrossMarketListingSchema) }),
  ),
});
