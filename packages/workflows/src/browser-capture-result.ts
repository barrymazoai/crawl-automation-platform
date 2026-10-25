import { z } from "zod";
import {
  AcquisitionReviewSchema,
  DtcScopeExcludedSchema,
  DtcVariantHandoffsSchema,
  NotSupplementSchema,
} from "@crawl-automation/v3-contracts";
import { CaptureResultSchema, ListingResultSchema } from "./pipeline-model.js";

/** A retained browser page, unlisted sighting, or a category-based terminal result. */
export const BrowserCaptureResultSchema = z.discriminatedUnion("status", [
  DtcScopeExcludedSchema,
  NotSupplementSchema,
  z.strictObject({
    status: z.literal("captured"),
    listingId: z.string().min(1).max(200),
    variantId: z.string().min(1).max(200).nullable(),
    archiveKey: z.string().min(1).max(1024),
    planned: CaptureResultSchema.options[0].optional(),
    variants: DtcVariantHandoffsSchema.optional(),
  }),
  AcquisitionReviewSchema,
  // Only browser captures can carry the DTC agent's moved product address; HTTP results keep their old schema.
  ListingResultSchema.extend({
    movedTo: z
      .strictObject({
        url: z.url().max(4096),
        listingId: z.string().min(1).max(200),
        variantId: z.null(),
      })
      .optional(),
  }),
]);
