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
});

export { validateBrandEnrichmentSettings } from "@crawl-automation/app";
