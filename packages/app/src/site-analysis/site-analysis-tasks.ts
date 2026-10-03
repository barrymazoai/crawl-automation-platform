import { z } from "zod";
import { ScanStateSchema } from "../brand-scans/scan-model.js";

export const SiteAnalysisTaskSchema = z.object({
  name: z.string(),
  brandId: z.uuid(),
  sourceId: z.uuid(),
  scanId: z.uuid(),
});
export const SiteAnalysisTaskProgressSchema = SiteAnalysisTaskSchema.extend({
  catalogUrl: z.url(),
  state: ScanStateSchema,
  code: z.string().nullable(),
  catalogComplete: z.boolean(),
  discovered: z.number().int().nonnegative(),
  products: z.record(z.string(), z.number().int().nonnegative()),
});
export type SiteAnalysisTaskProgress = z.infer<typeof SiteAnalysisTaskProgressSchema>;
