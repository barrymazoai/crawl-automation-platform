import { z } from "zod";
import {
  BrandEnrichmentStateSchema,
  CompanyLinkSchema,
  CompanyUnlinkSchema,
} from "@crawl-automation/v3-contracts";
export const StartBrandEnrichmentSchema = z.strictObject({ requestId: z.uuid() });
export const ClaimBrandEnrichmentSchema = z.strictObject({
  limit: z.number().int().min(1).max(100).default(10),
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
  ]),
});
export const SpotCheckBrandDecisionSchema = z.strictObject({
  decisionId: z.uuid(),
  correct: z.boolean(),
  note: z.string().trim().max(2000).optional(),
});
export { CompanyUnlinkSchema as UnlinkBrandCompanySchema };
