import { randomUUID } from "node:crypto";
import { z } from "zod";
import { brandProductsRetryWorkflowId } from "@crawl-automation/v3-contracts";
import type { BrandEnrichmentRuns } from "./ports.js";
import type { BrandEnrichmentGateway } from "./service-ports.js";
import { requireRun, saveOutput } from "./run-records.js";
import { productStep } from "./product-attempt.js";
import { brandEnrichmentErrors } from "./errors.js";

const reservationSchema = z.object({ reservationId: z.uuid() });
const terminalStatuses = new Set(["COMPLETED", "FAILED", "CANCELLED", "TERMINATED", "TIMED_OUT"]);

/** Operator-only retries: reserve once before publishing; unknown publication remains reserved. */
export class BrandProductsRetry {
  constructor(
    private readonly deps: { runs: BrandEnrichmentRuns; gateway: BrandEnrichmentGateway },
  ) {}

  async retry(runId: string) {
    const run = await requireRun(this.deps.runs, runId);
    if (run.state !== "completed" && run.state !== "failed") {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.INVALID_STATE");
    }
    const previous = await this.deps.runs.latestProductAttempt(runId);
    if (previous > 1) {
      const workflow = await this.deps.gateway.describeProductsRetry({ runId, attempt: previous });
      if (!workflow || !terminalStatuses.has(workflow.status)) {
        throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.INVALID_STATE", {
          details: {
            runId,
            attempt: previous,
            reason: "Previous retry is running or its start is unconfirmed",
          },
        });
      }
    }
    const attempt = previous + 1;
    await this.reserve(runId, attempt);
    await this.deps.gateway.startProductsRetry({ runId, attempt });
    return { runId, attempt, workflowId: brandProductsRetryWorkflowId({ runId, attempt }) };
  }

  private async reserve(runId: string, attempt: number) {
    const reservationId = randomUUID();
    const saved = reservationSchema.safeParse(
      await saveOutput(this.deps.runs, {
        runId,
        step: productStep("products-retry", attempt),
        output: { requestedAt: new Date().toISOString(), reservationId },
      }),
    );
    if (!saved.success || saved.data.reservationId !== reservationId) {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.INVALID_STATE", {
        details: { runId, attempt, reason: "Another operator reserved this retry" },
      });
    }
  }
}
