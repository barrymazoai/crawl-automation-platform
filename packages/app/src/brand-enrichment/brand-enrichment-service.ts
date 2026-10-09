import { randomUUID } from "node:crypto";
import type { BrandRequest } from "@crawl-automation/v3-contracts";
import type {
  BrandRequests,
  BrandEnrichmentRuns,
  BrandEnrichmentReviews,
  SupplySmartCompanies,
} from "./ports.js";
import type { BrandEnrichmentGateway } from "./service-ports.js";
import { brandEnrichmentErrors } from "./errors.js";
import { requireRun } from "./run-records.js";
import { BrandQuestionService } from "./question-service.js";
import * as inputs from "./api-model.js";
import type { BrandProductRedelivery } from "./product-redelivery.js";

/** Facade: the API's only entry point. Intake is explicitly requested, never a polling loop. */
export class BrandEnrichmentService {
  constructor(
    private readonly deps: {
      requests: BrandRequests;
      runs: BrandEnrichmentRuns;
      reviews: BrandEnrichmentReviews;
      companies: SupplySmartCompanies;
      gateway: BrandEnrichmentGateway;
      /** Absent when this process cannot reach the saved products (no storage configured). */
      redelivery?: BrandProductRedelivery;
    },
  ) {}

  async start(raw: unknown, signal = new AbortController().signal) {
    const { requestId } = inputs.StartBrandEnrichmentSchema.parse(raw);
    // The frozen request port exposes only the oldest pending page (no get-by-id or cursor).
    const request = (await this.deps.requests.pending(100, signal)).find(
      (item) => item.id === requestId,
    );
    if (!request) {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.NOT_FOUND", {
        details: { requestId, pendingWindow: 100 },
      });
    }
    return this.claim(request, signal);
  }

  async claimPending(raw: unknown, signal = new AbortController().signal) {
    const { limit } = inputs.ClaimBrandEnrichmentSchema.parse(raw);
    const pending = await this.deps.requests.pending(limit, signal);
    const results = [];
    for (const request of pending) {
      signal.throwIfAborted();
      try {
        results.push({ requestId: request.id, run: await this.claim(request, signal) });
      } catch (error) {
        results.push({ requestId: request.id, error: String(error) });
      }
    }
    return results;
  }

  private async claim(request: BrandRequest, signal: AbortSignal) {
    const claim = await this.deps.requests.update(
      { id: request.id, status: "in_progress" },
      signal,
    );
    if (!claim.claimed) {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.CLAIM_CONFLICT");
    }
    const runId = randomUUID();
    const result = await this.deps.runs.create({
      runId,
      requestId: request.id,
      parentRunId: null,
      role: "request",
      brandName: request.brandName,
      brandUrl: request.brandUrl,
      workflowId: `brand-enrichment-${runId}`,
    });
    // Unknown start publication is retained as running: never pretend the workflow did not start or retry business work.
    try {
      await this.deps.gateway.start(result.run.runId);
    } catch (error) {
      await this.deps.runs.update(result.run.runId, {
        stage: "start_unconfirmed",
        failureReason: String(error).slice(0, 1000),
      });
      throw error;
    }
    return result.run;
  }

  list(raw: unknown) {
    const { state, parentRunId, limit } = inputs.ListBrandEnrichmentSchema.parse(raw);
    return this.deps.runs.list({
      limit,
      ...(state ? { state } : {}),
      ...(parentRunId ? { parentRunId } : {}),
    });
  }
  async get(raw: unknown) {
    const { runId } = inputs.BrandRunIdSchema.parse(raw);
    const run = await requireRun(this.deps.runs, runId);
    const [children, clues, decisions, questions, workflow] = await Promise.all([
      this.deps.runs.list({ parentRunId: runId, limit: 1000 }),
      this.deps.runs.clues(runId),
      this.deps.reviews.decisions(runId),
      this.deps.reviews.questions({ runId, limit: 1000 }),
      this.deps.gateway.describe(runId),
    ]);
    const steps = Object.fromEntries(
      await Promise.all(
        [
          "family",
          "domain-additions",
          "products",
          "products-failure",
          "apollo",
          "write",
          "ownership-status",
          "reviewer-answer",
          "ownership-unresolved",
          "ownership-conflict",
          "parent-apollo-write",
        ].map(async (step) => [step, await this.deps.runs.step(runId, step)]),
      ),
    );
    return { ...run, children, clues, decisions, questions, workflow, steps };
  }
  async cancel(raw: unknown) {
    const { runId } = inputs.BrandRunIdSchema.parse(raw);
    const run = await requireRun(this.deps.runs, runId);
    if (run.state !== "running") {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.INVALID_STATE");
    }
    await this.deps.gateway.cancel(runId);
    return { runId, cancellationRequested: true };
  }
  questions(raw: unknown) {
    const { runId, state, limit } = inputs.BrandQuestionsSchema.parse(raw);
    return this.deps.reviews.questions({
      limit,
      ...(state ? { state } : {}),
      ...(runId ? { runId } : {}),
    });
  }
  answerQuestion(raw: unknown, signal = new AbortController().signal) {
    return new BrandQuestionService(this.deps).answer(
      inputs.AnswerBrandQuestionSchema.parse(raw),
      signal,
    );
  }
  unlink(raw: unknown, signal = new AbortController().signal) {
    return this.deps.companies.unlink(inputs.UnlinkBrandCompanySchema.parse(raw), signal);
  }
  /** Sends a closed run's products to Supply Smart again, e.g. after its Review products finished (owner 2026-10-09). */
  deliverProducts(raw: unknown, signal = new AbortController().signal) {
    const { runId } = inputs.BrandRunIdSchema.parse(raw);
    if (!this.deps.redelivery) {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.NOT_CONFIGURED");
    }
    return this.deps.redelivery.deliver(runId, signal);
  }
  spotCheck(raw: unknown) {
    const { decisionId, ...check } = inputs.SpotCheckBrandDecisionSchema.parse(raw);
    return this.deps.reviews.recordSpotCheck(decisionId, check);
  }
}
