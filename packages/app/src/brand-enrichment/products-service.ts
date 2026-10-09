import { z } from "zod";
import type { BrandProductProgress } from "@crawl-automation/v3-contracts";
import {
  SiteAnalysisApplyResultSchema,
  type SiteAnalysisApplyResult,
  type SiteAnalysisService,
} from "../site-analysis/site-analysis-service.js";
import type { BrandEnrichmentRuns } from "./ports.js";
import type { ProductDelivery } from "./task-ports.js";
import { domainOf, requireCompanyRun, saveOutput } from "./run-records.js";
import { brandEnrichmentErrors } from "./errors.js";

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
  async tick(runId: string, signal: AbortSignal): Promise<BrandProductProgress> {
    const run = await requireCompanyRun(this.deps.runs, runId);
    if ((await this.deps.runs.step(runId, "products")) || !run.brandUrl) {
      return { done: true };
    }
    const analysis = await this.analysis(runId, run.brandUrl);
    if (analysis.state === "queued" || analysis.state === "running") {
      return { done: false };
    }
    if (analysis.state !== "completed") {
      await saveOutput(this.deps.runs, {
        runId,
        step: "products",
        output: { captured: 0, review: 0, state: analysis.state, reasons: analysis.reasons },
      });
      return { done: true };
    }
    const applied = await this.apply(runId, analysis.analysisId);
    if (!(await this.settled(analysis.analysisId, applied))) {
      return { done: false };
    }
    const sourceIds = sourceIdsOf(applied);
    const siteKey = domainOf(run.brandUrl);
    if (!siteKey) {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.IDENTITY_UNRESOLVED");
    }
    const result = sourceIds.length
      ? await this.deps.delivery.deliver(
          {
            companyId: run.companyId,
            siteKey,
            sourceIds,
            ingestRunId: `brand-enrichment-${runId}`,
          },
          signal,
        )
      : { captured: 0, review: 0, reason: "No verified DTC sources", skipped: applied.skipped };
    await saveOutput(this.deps.runs, { runId, step: "products", output: result });
    return { done: true };
  }
  private async analysis(runId: string, url: string) {
    const reference = analysisReference.safeParse(
      await this.deps.runs.step(runId, "product-analysis"),
    );
    if (reference.success) {
      return this.deps.analyses.get(reference.data.analysisId);
    }
    const started = await this.deps.analyses.analyze({ requestId: runId, url });
    await saveOutput(this.deps.runs, { runId, step: "product-analysis", output: started });
    return this.deps.analyses.get(started.analysisId);
  }
  private async apply(runId: string, analysisId: string) {
    const applied = SiteAnalysisApplyResultSchema.safeParse(
      await this.deps.runs.step(runId, "product-sources"),
    );
    if (applied.success) {
      return applied.data;
    }
    const result = await this.deps.analyses.apply({ requestId: runId, analysisId, enqueue: true });
    await saveOutput(this.deps.runs, { runId, step: "product-sources", output: result });
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
  async stop(runId: string) {
    const reference = analysisReference.safeParse(
      await this.deps.runs.step(runId, "product-analysis"),
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

function sourceIdsOf(applied: SiteAnalysisApplyResult) {
  return [...new Set((applied.tasks ?? []).map((task) => task.sourceId))];
}
