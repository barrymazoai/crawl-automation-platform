import { z } from "zod";
import { ResourceGateSchema } from "./resources.js";

export const BrandEnrichmentWorkflowSettingsSchema = z.strictObject({
  taskQueue: z.string().min(1).max(200),
  queues: z.strictObject({ activities: z.string().min(1), model: z.string().min(1), browser: z.string().min(1) }),
  resources: ResourceGateSchema,
  limits: z.strictObject({
    subBrands: z.number().int().min(1).max(20).default(20),
    apolloSearches: z.number().int().min(1).max(3).default(3),
    productPollSeconds: z.number().int().min(5).max(300).default(30),
    productMaxPolls: z.number().int().min(1).max(10000).default(2880),
  }).prefault({}),
}).superRefine((settings, ctx) => {
  for (const activity of ["brandFamily", "brandResearch", "brandApollo", "brandContacts", "brandReview"]) {
    if (!settings.resources.activities[activity]?.length) {
      ctx.addIssue({ code: "custom", path: ["resources", "activities", activity], message: "A permit is required" });
    }
  }
});
export type BrandEnrichmentWorkflowSettings = z.infer<typeof BrandEnrichmentWorkflowSettingsSchema>;
export const BrandEnrichmentWorkflowInputSchema = z.strictObject({
  runId: z.uuid(), settings: BrandEnrichmentWorkflowSettingsSchema,
});
export type BrandEnrichmentWorkflowInput = z.infer<typeof BrandEnrichmentWorkflowInputSchema>;
export interface BrandFamilyPlan { children: string[]; products: boolean }
export interface BrandReviewPlan { ownerRunId?: string }
export interface BrandProductProgress { done: boolean }
