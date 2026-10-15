import {
  StartBrandEnrichmentSchema,
  StartMarketplaceBrandsSchema,
  ClaimBrandEnrichmentSchema,
  BrandRunIdSchema,
  ListBrandEnrichmentSchema,
  BrandQuestionsSchema,
  AnswerBrandQuestionSchema,
  UnlinkBrandCompanySchema,
  SpotCheckBrandDecisionSchema,
  RenameCompanySchema,
  MergeCompanySchema,
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
  /** Owner 2026-10-15: our brands whose marketplace products wait for a company; website → find or create. */
  startMarketplaceBrands: procedure
    .input(StartMarketplaceBrandsSchema)
    .mutation(async ({ ctx, input }) => (await service(ctx)).startMarketplace(input)),
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
  /** Sends a closed run's settled products to Supply Smart again (same sources, same ingest run). */
  deliverProducts: procedure
    .input(BrandRunIdSchema)
    .mutation(async ({ ctx, input }) => (await service(ctx)).deliverProducts(input)),
  retryProducts: procedure
    .input(BrandRunIdSchema)
    .mutation(async ({ ctx, input }) => (await service(ctx)).retryProducts(input)),
  unlink: procedure
    .input(UnlinkBrandCompanySchema)
    .mutation(async ({ ctx, input }) => (await service(ctx)).unlink(input)),
  /** Owner-approved corrections in Supply Smart (2026-10-15); never called by a workflow. */
  renameCompany: procedure
    .input(RenameCompanySchema)
    .mutation(async ({ ctx, input }) => (await service(ctx)).corrections.rename(input)),
  /** Dry run by default; `dryRun: false` merges and repoints our brand matches and runs to the survivor. */
  mergeCompany: procedure
    .input(MergeCompanySchema)
    .mutation(async ({ ctx, input }) => (await service(ctx)).corrections.merge(input)),
  spotCheck: procedure
    .input(SpotCheckBrandDecisionSchema)
    .mutation(async ({ ctx, input }) => (await service(ctx)).spotCheck(input)),
});
