import { SiteAnalysisApplyResultSchema } from "../site-analysis/site-analysis-service.js";
import type { BrandEnrichmentRuns } from "./ports.js";
import type { ProductDelivery } from "./task-ports.js";
import { requireCompanyRun, saveOutput } from "./run-records.js";
import { brandEnrichmentErrors } from "./errors.js";
import { savedFamily } from "./saved-family.js";
import { deliverBrandProducts } from "./product-delivery-step.js";

/**
 * Sends a brand's products again after its run closed (owner 2026-10-09): products that were in Review or still running
 * when the run delivered, and finished later, reach Supply Smart this way. Same sources, same ingest run.
 */
export class BrandProductRedelivery {
  constructor(private readonly deps: { runs: BrandEnrichmentRuns; delivery: ProductDelivery }) {}

  async deliver(runId: string, signal: AbortSignal) {
    const run = await requireCompanyRun(this.deps.runs, runId);
    if (run.state === "running") {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.INVALID_STATE", {
        details: { runId, reason: "The run still delivers its own products" },
      });
    }
    const applied = SiteAnalysisApplyResultSchema.safeParse(
      await this.deps.runs.step(runId, "product-sources"),
    );
    const family = await savedFamily(this.deps.runs, runId);
    const url = family.absorbed ? family.catalogUrl : run.brandUrl;
    if (!applied.success || !url) {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.INVALID_STATE", {
        details: { runId, reason: "The run has no product sources to deliver" },
      });
    }
    const result = await deliverBrandProducts(
      this.deps.delivery,
      { runId, companyId: run.companyId, url, applied: applied.data },
      signal,
    );
    await saveOutput(this.deps.runs, {
      runId,
      step: `products-redelivery-${new Date().toISOString()}`,
      output: result,
    });
    return { runId, ...result };
  }
}
