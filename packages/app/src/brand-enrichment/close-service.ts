import { z } from "zod";
import type { BrandEnrichmentRuns, BrandRequests, SupplySmartCompanies } from "./ports.js";
import { requireRun } from "./run-records.js";
import { BrandSummaryService } from "./summary-service.js";

export const CloseBrandRunSchema = z.strictObject({
  runId: z.uuid(),
  state: z.enum(["completed", "failed", "cancelled"]),
  reason: z.string().optional(),
  cleanupPending: z.boolean().optional(),
});

/** One terminal path for every run. Only the root request sends a Supply Smart completion/email. */
export class BrandCloseService {
  constructor(
    private readonly deps: {
      runs: BrandEnrichmentRuns;
      requests: BrandRequests;
      companies: SupplySmartCompanies;
    },
  ) {}
  async close(input: z.infer<typeof CloseBrandRunSchema>, signal: AbortSignal) {
    const run = await requireRun(this.deps.runs, input.runId);
    const summary = await new BrandSummaryService(this.deps).build(input.runId);
    const reason = (input.reason || `Brand enrichment ${input.state}`).slice(0, 1000);
    await this.deps.runs.update(input.runId, {
      state: input.state,
      stage: input.cleanupPending ? "cleanup_pending" : "closing",
      summary,
      ...(input.state !== "completed" ? { failureReason: reason } : {}),
    });
    if (run.role === "request" && run.requestId) {
      await this.deps.requests.update(
        input.state === "completed" && run.companyId
          ? { id: run.requestId, status: "completed", companyId: run.companyId, summary }
          : { id: run.requestId, status: "failed", reason, summary },
        signal,
      );
    }
    return this.deps.runs.update(input.runId, {
      stage: input.cleanupPending ? "cleanup_pending" : "closed",
    });
  }
}
