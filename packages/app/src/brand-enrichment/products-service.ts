import { z } from "zod";
import type { BrandProductProgress } from "@crawl-automation/v3-contracts";
import {
  SiteAnalysisApplyResultSchema,
  type SiteAnalysisApplyResult,
  type SiteAnalysisService,
} from "../site-analysis/site-analysis-service.js";
import type { BrandEnrichmentRuns } from "./ports.js";
import type { ProductDelivery } from "./task-ports.js";
import { requireCompanyRun, saveOutput } from "./run-records.js";
import { savedFamily } from "./saved-family.js";
import { deliverBrandProducts } from "./product-delivery-step.js";
import { productStep, productAnalysisRequestId, operationRequestId } from "./product-attempt.js";
export { operationRequestId } from "./product-attempt.js";
type Attempt = { runId: string; attempt: number };

/** Cancellation of the exact site-analysis workflow and scans this run submitted, never a whole browser/queue. */
export interface BrandProductExecution {
  stop(input: { analysisId: string; scanIds: string[] }): Promise<void>;
}
const analysisReference = z.object({ analysisId: z.uuid() });
const settledStates = new Set(["completed", "review"]);

/** Reuses DTC analysis/apply/queue and retains its results. Temporal supplies the bounded wait between ticks. */
export class BrandProductsService {
  constructor(
    private readonly deps: {
      runs: BrandEnrichmentRuns;
      analyses: SiteAnalysisService;
      delivery: ProductDelivery;
      execution: BrandProductExecution;
    },
  ) {}
  async tick(runId: string, signal: AbortSignal, attempt = 1): Promise<BrandProductProgress> {
    const run = await requireCompanyRun(this.deps.runs, runId);
    if (await this.deps.runs.step(runId, productStep("products", attempt))) {
      return { done: true };
    }
    const family = await savedFamily(this.deps.runs, runId);
    const url = family.absorbed ? family.catalogUrl : run.brandUrl;
    if (!url) {
      await this.missingCatalog({ runId, attempt }, family.absorbed);
      return { done: true };
    }
    const analysis = await this.analysis({ runId, attempt }, url);
    if (analysis.state === "queued" || analysis.state === "running") {
      return { done: false };
    }
    if (analysis.state !== "completed") {
      await saveOutput(this.deps.runs, {
        runId,
        step: productStep("products", attempt),
        output: { captured: 0, review: 0, state: analysis.state, reasons: analysis.reasons },
      });
      return { done: true };
    }
    const applied = await this.apply(
      { runId, attempt },
      { analysisId: analysis.analysisId, catalogUrl: family.absorbed ? url : undefined },
    );
    if (!(await this.settled(analysis.analysisId, applied))) {
      return { done: false };
    }
    await this.deliver({ runId, attempt, companyId: run.companyId, url, applied }, signal);
    return { done: true };
  }
  private async missingCatalog({ runId, attempt }: Attempt, absorbed: boolean) {
    await saveOutput(this.deps.runs, {
      runId,
      step: productStep("products", attempt),
      output: {
        captured: 0,
        review: 0,
        reason: absorbed ? "absorbed_brand_without_catalog" : "missing_brand_url",
      },
    });
  }
  private async deliver(
    input: {
      runId: string;
      attempt: number;
      companyId: string;
      url: string;
      applied: SiteAnalysisApplyResult;
    },
    signal: AbortSignal,
  ) {
    const result = await deliverBrandProducts(this.deps.delivery, input, signal);
    await saveOutput(this.deps.runs, {
      runId: input.runId,
      step: productStep("products", input.attempt),
      output: result,
    });
  }
  private async analysis({ runId, attempt }: Attempt, url: string) {
    const reference = analysisReference.safeParse(
      await this.deps.runs.step(runId, productStep("product-analysis", attempt)),
    );
    if (reference.success) {
      return this.deps.analyses.get(reference.data.analysisId);
    }
    const started = await this.deps.analyses.analyze({
      requestId: productAnalysisRequestId(runId, attempt),
      url,
    });
    await saveOutput(this.deps.runs, {
      runId,
      step: productStep("product-analysis", attempt),
      output: started,
    });
    return this.deps.analyses.get(started.analysisId);
  }
  private async apply(
    { runId, attempt }: Attempt,
    { analysisId, catalogUrl }: { analysisId: string; catalogUrl: string | undefined },
  ) {
    const applied = SiteAnalysisApplyResultSchema.safeParse(
      await this.deps.runs.step(runId, productStep("product-sources", attempt)),
    );
    if (applied.success) {
      return applied.data;
    }
    const result = await this.deps.analyses.apply({
      // One receipt per request ID: analyze already used the run ID (MANTRA Labs, 2026-10-09: REQUEST.ID_CONFLICT).
      requestId: operationRequestId(runId, attempt === 1 ? "apply" : `apply@${attempt}`),
      analysisId,
      enqueue: true,
      ...(catalogUrl ? { catalogUrl } : {}),
    });
    await saveOutput(this.deps.runs, {
      runId,
      step: productStep("product-sources", attempt),
      output: result,
    });
    return result;
  }
  private async settled(analysisId: string, applied: SiteAnalysisApplyResult) {
    const progress = await this.deps.analyses.tasks(analysisId);
    const expected = applied.tasks ?? [];
    if (expected.some((task) => !progress.tasks.some((item) => item.scanId === task.scanId))) {
      return false;
    }
    return !progress.tasks.some(
      (task) =>
        ["queued", "running"].includes(task.state) ||
        Object.entries(task.products).some(
          ([state, count]) => count > 0 && !settledStates.has(state),
        ),
    );
  }
  async stop(runId: string, attempt = 1) {
    const reference = analysisReference.safeParse(
      await this.deps.runs.step(runId, productStep("product-analysis", attempt)),
    );
    if (!reference.success) {
      return;
    }
    const progress = await this.deps.analyses.tasks(reference.data.analysisId);
    await this.deps.execution.stop({
      analysisId: reference.data.analysisId,
      scanIds: progress.tasks.map((task) => task.scanId),
    });
  }
}
