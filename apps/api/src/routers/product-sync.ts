import {
  brandCompanyErrors,
  ListSyncBrandsSchema,
  MarkPresentSchema,
  MatchBrandsSchema,
  RemoveNotSupplementsSchema,
  UpdateEnrichmentSchema,
  ReopenSyncSchema,
} from "@crawl-automation/app";
import { procedure, router, type ApiContext } from "../trpc.js";

async function service(ctx: Pick<ApiContext, "productSync">) {
  const service = await ctx.productSync;
  if (!service) {
    throw brandCompanyErrors.create("PRODUCT_SYNC.NOT_CONFIGURED");
  }
  return service;
}

/** No authentication; input validation and one application operation per procedure. */
export const productSyncRouter = router({
  matchBrands: procedure
    .input(MatchBrandsSchema)
    .mutation(async ({ ctx, input, signal }) => (await service(ctx)).matchBrands(input, signal)),
  brands: procedure
    .input(ListSyncBrandsSchema)
    .query(async ({ ctx, input }) => (await service(ctx)).brands(input)),
  /** Per channel: completed, matched-brand and pending products, and the sync ledger's statuses. */
  status: procedure.query(async ({ ctx }) => (await service(ctx)).status()),
  /** Failed products with this reason become pending again (after a fix); nothing is deleted. */
  reopen: procedure
    .input(ReopenSyncSchema)
    .mutation(async ({ ctx, input, signal }) => (await service(ctx)).reopen(input, signal)),
  /**
   * Deletes Supply Smart products of listings outside supplements that the crawler created (dry run by default);
   * a page at a time, continued with the answer's `next`.
   */
  removeNotSupplements: procedure
    .input(RemoveNotSupplementsSchema)
    .mutation(async ({ ctx, input, signal }) =>
      (await service(ctx)).removeNotSupplements(input, signal),
    ),
  /**
   * Brings form, health functions and main ingredients of products in Supply Smart up to their current enrichment
   * (product.updateEnrichmentBatch; dry run by default); a page at a time, continued with the answer's `next`.
   */
  updateEnrichment: procedure
    .input(UpdateEnrichmentSchema)
    .mutation(async ({ ctx, input, signal }) =>
      (await service(ctx)).updateEnrichment(input, signal),
    ),
  /** Records listings already in Supply Smart so the sweep does not send them again. */
  markPresent: procedure
    .input(MarkPresentSchema)
    .mutation(async ({ ctx, input }) => (await service(ctx)).markPresent(input)),
});
