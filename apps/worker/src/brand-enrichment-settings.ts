import { isAbsolute } from "node:path";
import { z } from "zod";
import { BrandEnrichmentWorkflowSettingsSchema } from "@crawl-automation/v3-contracts";

export const BrandEnrichmentSettingsSchema = BrandEnrichmentWorkflowSettingsSchema.safeExtend({
  secretsFile: z.string().refine(isAbsolute, "Must be an absolute path"),
  reviewerModel: z.string().min(1),
  limits: BrandEnrichmentWorkflowSettingsSchema.shape.limits
    .unwrap()
    .extend({
      /** Automatic late-product delivery; zero disables this worker-owned loop. */
      redeliverySweepMinutes: z.number().int().min(0).max(1440).default(15),
      /** Look back from the run's completion time, not its creation time. */
      redeliveryLookbackDays: z.number().int().min(1).default(30),
    })
    .prefault({}),
  /**
   * Marketplace products to Supply Smart (owner 2026-10-12). Zero minutes disables the loop; the first deploy runs a
   * small smoke batch before the limits are raised.
   */
  productSync: z
    .strictObject({
      sweepMinutes: z.number().int().min(0).max(1440).default(0),
      channels: z
        .array(z.enum(["amazon", "gnc", "swanson", "wholefoods", "costco"]))
        .default(["amazon", "gnc", "swanson", "wholefoods", "costco"]),
      batchLimit: z.number().int().min(1).max(200).default(200),
      maxBatchesPerChannel: z.number().int().min(1).max(50).default(5),
    })
    .prefault({}),
});

export { validateBrandEnrichmentSettings } from "@crawl-automation/app";
export type BrandEnrichmentSettings = z.infer<typeof BrandEnrichmentSettingsSchema>;
