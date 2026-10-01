import { EnrichmentBackfillSchema } from "@crawl-automation/app";
import { enrichmentErrors } from "@crawl-automation/processing";
import { EnrichmentRequestSchema } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import { procedure, router, type ApiContext } from "../trpc.js";

function service(enrichment: ApiContext["enrichment"]) {
  if (!enrichment) {
    throw enrichmentErrors.create("ENRICH.SETTINGS_MISSING");
  }
  return enrichment;
}

/** Read first, then explicitly approve a bounded count. No automatic backfill at startup. */
export const enrichmentRouter = router({
  result: procedure
    .input(EnrichmentRequestSchema)
    .query(({ ctx, input }) => service(ctx.enrichment).result(input)),
  missing: procedure
    .input(z.strictObject({ limit: z.number().int().min(1).max(100) }))
    .query(({ ctx, input }) => service(ctx.enrichment).list(input.limit)),
  run: procedure
    .input(EnrichmentBackfillSchema)
    .mutation(({ ctx, input }) => service(ctx.enrichment).run(input)),
});
