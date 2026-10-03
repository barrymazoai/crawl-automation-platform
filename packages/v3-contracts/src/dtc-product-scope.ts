import { z } from "zod";
import { ExecutionIdSchema } from "./artifacts.js";
import { DtcGalleryRefSchema } from "./dtc-gallery.js";

/** A retained, model-reviewed multi-product offer; no formula or enrichment was collected. */
export const DtcScopeExcludedSchema = z.strictObject({
  status: z.literal("scope-excluded"),
  operationId: ExecutionIdSchema,
  listingId: z.string().min(1),
  variantId: z.string().nullable(),
  reason: z.literal("DTC.MULTI_PRODUCT_BUNDLE"),
  policy: z.literal("dtc-product-scope/1"),
  evidence: DtcGalleryRefSchema,
});
export type DtcScopeExcluded = z.infer<typeof DtcScopeExcludedSchema>;
