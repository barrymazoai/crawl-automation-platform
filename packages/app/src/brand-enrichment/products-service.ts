import { createHash } from "node:crypto";
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
    if (await this.deps.runs.step(runId, "products")) {
      return { done: true };
    }
    const family = await savedFamily(this.deps.runs, runId);
    const url = family.absorbed ? family.catalogUrl : run.brandUrl;
    if (!url) {
      await saveOutput(this.deps.runs, {
        runId,
        step: "products",
        output: {
          captured: 0,
          review: 0,
          reason: family.absorbed ? "absorbed_brand_without_catalog" : "missing_brand_url",
        },
      });
      return { done: true };
    }
    const analysis = await this.analysis(runId, url);
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
    const applied = await this.apply(runId, analysis.analysisId, family.absorbed ? url : undefined);
    if (!(await this.settled(analysis.analysisId, applied))) {
      return { done: false };
    }
    await this.deliver({ runId, companyId: run.companyId, url, applied }, signal);
    return { done: true };
  }
  private async deliver(
    input: { runId: string; companyId: string; url: string; applied: SiteAnalysisApplyResult },
    signal: AbortSignal,
  ) {
    const result = await deliverBrandProducts(this.deps.delivery, input, signal);
    await saveOutput(this.deps.runs, { runId: input.runId, step: "products", output: result });
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
  private async apply(runId: string, analysisId: string, catalogUrl?: string) {
    const applied = SiteAnalysisApplyResultSchema.safeParse(
      await this.deps.runs.step(runId, "product-sources"),
    );
    if (applied.success) {
      return applied.data;
    }
    const result = await this.deps.analyses.apply({
      // One receipt per request ID: analyze already used the run ID (MANTRA Labs, 2026-10-09: REQUEST.ID_CONFLICT).
      requestId: operationRequestId(runId, "apply"),
      analysisId,
      enqueue: true,
      ...(catalogUrl ? { catalogUrl } : {}),
    });
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

/** A stable request ID per operation of a run: the same run retries with the same ID, never another operation's. */
export function operationRequestId(runId: string, operation: string): string {
  const hex = createHash("sha256").update(`${runId}:${operation}`).digest("hex");
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
