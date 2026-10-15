import { z } from "zod";
import {
  BrandEnrichmentStateSchema,
  CompanyLinkSchema,
  CompanyMergeSchema,
  CompanyRenameSchema,
  CompanyUnlinkSchema,
} from "@crawl-automation/v3-contracts";
export const StartBrandEnrichmentSchema = z.strictObject({ requestId: z.uuid() });
export const ClaimBrandEnrichmentSchema = z.strictObject({
  limit: z.number().int().min(1).max(100).default(10),
});
export const StartMarketplaceBrandsSchema = z.strictObject({
  limit: z.number().int().min(1).max(100).default(10),
  /** Named brands are started even after an earlier marketplace run; otherwise each brand gets one attempt. */
  brandIds: z.array(z.uuid()).min(1).max(100).optional(),
});
export const BrandRunIdSchema = z.strictObject({ runId: z.uuid() });
export const ListBrandEnrichmentSchema = z.strictObject({
  state: BrandEnrichmentStateSchema.optional(),
  parentRunId: z.uuid().optional(),
  limit: z.number().int().min(1).max(1000).default(100),
});
export const BrandQuestionsSchema = z.strictObject({
  runId: z.uuid().optional(),
  state: z.enum(["open", "answered", "dismissed"]).optional(),
  limit: z.number().int().min(1).max(1000).default(100),
});
export const AnswerBrandQuestionSchema = z.strictObject({
  runId: z.uuid(),
  questionId: z.uuid(),
  answer: z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("dismiss"), reason: z.string().trim().min(1) }),
    z.strictObject({ action: z.literal("independent"), reason: z.string().trim().min(1) }),
    z.strictObject({
      action: z.literal("link"),
      link: CompanyLinkSchema,
      reason: z.string().trim().min(1),
    }),
    /** Identity questions (owner 2026-10-15): the brand is this listed existing company… */
    z.strictObject({
      action: z.literal("same"),
      companyId: z.uuid(),
      reason: z.string().trim().min(1),
    }),
    /** …or none of them, and a new company is created. */
    z.strictObject({ action: z.literal("new"), reason: z.string().trim().min(1) }),
  ]),
});
/** Owner-approved corrections in Supply Smart (2026-10-15); a merge is a dry run unless `dryRun: false`. */
export { CompanyRenameSchema as RenameCompanySchema, CompanyMergeSchema as MergeCompanySchema };
export const SpotCheckBrandDecisionSchema = z.strictObject({
  decisionId: z.uuid(),
  correct: z.boolean(),
  note: z.string().trim().max(2000).optional(),
});
export { CompanyUnlinkSchema as UnlinkBrandCompanySchema };
