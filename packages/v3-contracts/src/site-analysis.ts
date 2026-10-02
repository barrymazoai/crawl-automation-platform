import { z } from "zod";

export const SiteUrlSchema = z.url().max(2000).refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash &&
    !url.port && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname);
}, "A public HTTPS site URL without credentials, port or fragment is required");
export const SiteAnalysisLimitsSchema = z.object({
  maxBrands: z.number().int().min(1).max(500).default(50),
  maxPages: z.number().int().min(1).max(500).default(100),
  maxDomains: z.number().int().min(1).max(100).default(50),
});
export const AnalyzedBrandSchema = z.object({
  name: z.string().trim().min(1).max(1000),
  domain: z.string().min(1),
  platform: z.enum(["shopify", "woocommerce", "jsonld"]),
  catalogUrl: SiteUrlSchema.nullable(),
  productCount: z.number().int().nonnegative(),
  countExact: z.boolean(),
  wholeCatalog: z.boolean(),
  discoveredFrom: z.union([z.literal("platform-data"), z.object({ page: SiteUrlSchema, link: SiteUrlSchema })]),
  status: z.enum(["verified", "needs-review"]),
  reason: z.string().nullable(),
});
export const SiteAnalysisResultSchema = z.object({
  state: z.enum(["completed", "needs-review", "failed"]),
  brands: z.array(AnalyzedBrandSchema),
  archiveKeys: z.array(z.string()),
  reasons: z.array(z.string()),
});
export const SiteAnalysisSchema = SiteAnalysisResultSchema.extend({
  analysisId: z.uuid(),
  url: SiteUrlSchema,
  state: z.enum(["queued", "running", "completed", "needs-review", "failed"]),
  limits: SiteAnalysisLimitsSchema,
});
export type AnalyzedBrand = z.infer<typeof AnalyzedBrandSchema>;
export type SiteAnalysis = z.infer<typeof SiteAnalysisSchema>;
export type SiteAnalysisResult = z.infer<typeof SiteAnalysisResultSchema>;
export type SiteAnalysisLimits = z.infer<typeof SiteAnalysisLimitsSchema>;
