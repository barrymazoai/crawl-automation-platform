import { SiteAnalysisApplyResultSchema } from "../site-analysis/site-analysis-service.js";
import type { BrandEnrichmentRuns } from "./ports.js";
import type { ProductDelivery } from "./task-ports.js";
import { requireCompanyRun, saveOutput } from "./run-records.js";
import { brandEnrichmentErrors } from "./errors.js";
import { productStep } from "./product-attempt.js";
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
    const attempt = await this.deps.runs.latestProductAttempt(runId);
    const applied = SiteAnalysisApplyResultSchema.safeParse(
      await this.deps.runs.step(runId, productStep("product-sources", attempt)),
    );
    if (!applied.success) {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.INVALID_STATE", {
        details: { runId, reason: "The run has no product sources to deliver" },
      });
    }
    const result = await deliverBrandProducts(
      this.deps.delivery,
      { runId, companyId: run.companyId, applied: applied.data },
      signal,
    );
    await saveOutput(this.deps.runs, {
      runId,
      step: `products-redelivery-${new Date().toISOString()}`,
      output: { ...result, attempt },
    });
    return { runId, ...result };
  }
}
