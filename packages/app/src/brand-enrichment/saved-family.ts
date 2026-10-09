import { FamilyFindingSchema } from "@crawl-automation/v3-contracts";
import type { BrandEnrichmentRuns } from "./ports.js";

// Runs saved before catalogUrl was introduced still carry authoritative redirect evidence.
const savedFamilySchema = FamilyFindingSchema.pick({ redirect: true }).extend({
  catalogUrl: FamilyFindingSchema.shape.catalogUrl.optional().default(null),
});

export async function savedFamily(runs: BrandEnrichmentRuns, runId: string) {
  const finding = savedFamilySchema.safeParse(await runs.step(runId, "family"));
  return {
    absorbed: finding.success && finding.data.redirect?.sameBrand === false,
    catalogUrl: finding.success ? finding.data.catalogUrl : null,
  };
}
