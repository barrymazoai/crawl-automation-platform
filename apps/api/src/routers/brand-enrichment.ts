import {
  StartBrandEnrichmentSchema,
  ClaimBrandEnrichmentSchema,
  BrandRunIdSchema,
  ListBrandEnrichmentSchema,
  BrandQuestionsSchema,
  AnswerBrandQuestionSchema,
  UnlinkBrandCompanySchema,
  SpotCheckBrandDecisionSchema,
  brandEnrichmentErrors,
} from "@crawl-automation/app";
import { procedure, router, type ApiContext } from "../trpc.js";

async function service(ctx: Pick<ApiContext, "brandEnrichment">) {
  const service = await ctx.brandEnrichment;
  if (!service) {
    throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.NOT_CONFIGURED");
  }
  return service;
}
/** No authentication: validated inputs call exactly one application facade operation. */
export const brandEnrichmentRouter = router({
  start: procedure
    .input(StartBrandEnrichmentSchema)
    .mutation(async ({ ctx, input }) => (await service(ctx)).start(input)),
  claimPending: procedure
    .input(ClaimBrandEnrichmentSchema)
    .mutation(async ({ ctx, input }) => (await service(ctx)).claimPending(input)),
  list: procedure
    .input(ListBrandEnrichmentSchema)
    .query(async ({ ctx, input }) => (await service(ctx)).list(input)),
  get: procedure
    .input(BrandRunIdSchema)
    .query(async ({ ctx, input }) => (await service(ctx)).get(input)),
  cancel: procedure
    .input(BrandRunIdSchema)
    .mutation(async ({ ctx, input }) => (await service(ctx)).cancel(input)),
  questions: procedure
    .input(BrandQuestionsSchema)
    .query(async ({ ctx, input }) => (await service(ctx)).questions(input)),
  answerQuestion: procedure
    .input(AnswerBrandQuestionSchema)
    .mutation(async ({ ctx, input }) => (await service(ctx)).answerQuestion(input)),
  unlink: procedure
    .input(UnlinkBrandCompanySchema)
    .mutation(async ({ ctx, input }) => (await service(ctx)).unlink(input)),
  spotCheck: procedure
    .input(SpotCheckBrandDecisionSchema)
    .mutation(async ({ ctx, input }) => (await service(ctx)).spotCheck(input)),
});
