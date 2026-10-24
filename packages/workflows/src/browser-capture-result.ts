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
  ListingResultSchema,
]);
