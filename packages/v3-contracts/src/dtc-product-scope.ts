import { z } from "zod";
import { ExecutionIdSchema } from "./artifacts.js";
import { DtcGalleryRefSchema } from "./dtc-gallery.js";

/**
 * A retained multi-product offer established by model evidence or the store's category; no formula was collected.
 * dtc-review-scope/1 asks after a label Review (owner 2026-10-30); `categories` then names the cited components.
 */
export const DtcScopeExcludedSchema = z.strictObject({
  status: z.literal("scope-excluded"),
  operationId: ExecutionIdSchema,
  listingId: z.string().min(1),
  variantId: z.string().nullable(),
  reason: z.literal("DTC.MULTI_PRODUCT_BUNDLE"),
  policy: z.enum([
    "dtc-product-scope/1",
    "dtc-product-scope/2",
    "store-category/1",
    "dtc-review-scope/1",
  ]),
  evidence: DtcGalleryRefSchema,
  categories: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
});
export type DtcScopeExcluded = z.infer<typeof DtcScopeExcludedSchema>;
