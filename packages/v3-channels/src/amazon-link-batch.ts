import { z } from "zod";
import { CatalogScopeSchema, CatalogEntrySchema } from "@crawl-automation/v3-contracts";
import { amazonProductAddress } from "./amazon-rendered.js";

// An imported list is positive input provenance, never a website coverage claim.
export const AmazonLinkBatchSchema = z.strictObject({
  codec: z.literal("amazon-link-batch/1"), requestId: z.uuid(),
  scope: CatalogScopeSchema.refine(s => s.channel === "amazon"),
  candidateManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  entries: z.array(z.strictObject({ entry: CatalogEntrySchema,
    candidateId: z.string().regex(/^[a-f0-9]{64}$/),
    historyListingId: z.string().regex(/^[a-f0-9]{64}$/),
  // One bounded request can keep the normal Temporal pipeline occupied. Browser
  // and provider permits still control execution; this is not browser concurrency.
  })).min(1).max(10),
}).superRefine((b, ctx) => {
  const ids = new Set<string>();
  for (const { entry } of b.entries) {
    try {
      const a = amazonProductAddress(entry.url);
      if (a.asin !== entry.listingId || a.url !== entry.url || entry.variantId !== null || entry.kind !== "product" || ids.has(a.asin)) throw Error();
      ids.add(a.asin);
    } catch { ctx.addIssue({ code: "custom", message: "Unique canonical selected Amazon ASIN required" }); }
  }
});
export const AmazonLinkBatchesSchema = z.array(AmazonLinkBatchSchema).max(2000).refine(b => new Set(b.map(x => x.requestId)).size === b.length);
export type AmazonLinkBatch = z.infer<typeof AmazonLinkBatchSchema>;
