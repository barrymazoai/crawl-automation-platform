import { isAbsolute } from "node:path";
import { z } from "zod";
import { BrandEnrichmentWorkflowSettingsSchema } from "@crawl-automation/v3-contracts";

export const BrandEnrichmentSettingsSchema = BrandEnrichmentWorkflowSettingsSchema.safeExtend({
  secretsFile: z.string().refine(isAbsolute, "Must be an absolute path"),
  reviewerModel: z.string().min(1),
});

export { validateBrandEnrichmentSettings } from "@crawl-automation/app";
