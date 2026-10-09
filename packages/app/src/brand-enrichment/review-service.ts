import {
  BrandResearchSchema,
  OwnershipStatusSchema,
  ReviewerVerdictSchema,
  type BrandReviewPlan,
  type ReviewerVerdict,
} from "@crawl-automation/v3-contracts";
import type { BrandEnrichmentRuns, BrandEnrichmentReviews, SupplySmartCompanies } from "./ports.js";
import type { OwnershipReviewer } from "./task-ports.js";
import { requireCompanyRun, saveOutput } from "./run-records.js";
import { brandFacts } from "./brand-facts.js";
import { BrandOwnerService } from "./owner-service.js";

/** Separate reviewer turn. Decisions and uncertainty remain local; only final links/checks cross the port. */
export class BrandReviewService {
  constructor(
    private readonly deps: {
      runs: BrandEnrichmentRuns;
      reviews: BrandEnrichmentReviews;
      companies: SupplySmartCompanies;
      reviewer: OwnershipReviewer;
      model: string;
    },
  ) {}
  async review(runId: string, signal: AbortSignal): Promise<BrandReviewPlan> {
    const run = await requireCompanyRun(this.deps.runs, runId);
    if (run.role === "owner" || (await this.existing(runId))) {
      return {};
    }
    const verdict = await this.verdict(runId, signal);
    const owners = new BrandOwnerService(this.deps);
    await saveOutput(this.deps.runs, { runId, step: "reviewer-answer", output: verdict });
    const owner = await this.ownerFor({ runId, verdict, owners }, signal);
    const decision = await this.decision({
      runId,
      verdict,
      ownerCompanyId: ownerId(owner),
    });
    await saveOutput(this.deps.runs, {
      runId,
      step: "verdict",
      output: { verdict, decisionId: decision.decisionId },
    });
    if (verdict.verdict === "independent") {
      return this.independent(
        { runId, companyId: run.companyId, verdict, decisionId: decision.decisionId },
        signal,
      );
    }
    if (verdict.verdict !== "owner" || !owner?.company || owner.company.id === run.companyId) {
      await this.deps.reviews.addQuestion(runId, "ownership", {
        verdict,
        resolution: owner ? owner.resolution : null,
      });
      await saveOutput(this.deps.runs, { runId, step: "ownership", output: "waiting_for_person" });
      return {};
    }
    return owners.prepare({ run, company: owner.company, created: owner.created, verdict });
  }
  private async ownerFor(
    input: { runId: string; verdict: ReviewerVerdict; owners: BrandOwnerService },
    signal: AbortSignal,
  ) {
    if (input.verdict.verdict !== "owner") {
      return null;
    }
    try {
      return await input.owners.resolve(input.verdict, signal);
    } catch (error) {
      await this.decision({ runId: input.runId, verdict: input.verdict, ownerCompanyId: null });
      throw error;
    }
  }
  private async verdict(runId: string, signal: AbortSignal) {
    const research = BrandResearchSchema.parse(await this.deps.runs.step(runId, "research"));
    const verdict = ReviewerVerdictSchema.parse(
      await this.deps.reviewer.review(
        {
          brand: await brandFacts(this.deps.runs, runId),
          clues: await this.deps.runs.clues(runId),
          checkedUrls: research.checkedUrls,
        },
        signal,
      ),
    );
    return verdict;
  }
  private async existing(runId: string) {
    const status = OwnershipStatusSchema.parse(
      await this.deps.runs.step(runId, "ownership-status"),
    );
    if (!status.owners.length && !status.latestCheck) {
      return false;
    }
    const ownership =
      status.owners.length || status.latestCheck?.result === "has_parent"
        ? "has_parent"
        : "independent";
    await saveOutput(this.deps.runs, { runId, step: "ownership", output: ownership });
    return true;
  }
  private decision(input: {
    runId: string;
    verdict: ReviewerVerdict;
    ownerCompanyId: string | null;
  }) {
    const { runId, verdict, ownerCompanyId } = input;
    return this.deps.reviews.addDecision({
      runId,
      verdict: verdict.verdict,
      ownerCompanyId,
      kind: verdict.verdict === "owner" ? verdict.kind : null,
      confidence: "confidence" in verdict ? verdict.confidence : null,
      reason: verdict.reason,
      signals: verdict.verdict === "owner" ? verdict.signals : [],
      decidedBy: `codex:${this.deps.model}`,
    });
  }
  private async independent(
    input: { runId: string; companyId: string; verdict: ReviewerVerdict; decisionId: string },
    signal: AbortSignal,
  ) {
    await this.deps.companies.recordOwnershipCheck(
      {
        companyId: input.companyId,
        result: "independent",
        signals: [],
        note: input.verdict.reason.slice(0, 2000),
      },
      signal,
    );
    await this.deps.reviews.markDecisionSent(input.decisionId, { ownership: "independent" });
    await saveOutput(this.deps.runs, {
      runId: input.runId,
      step: "ownership",
      output: "independent",
    });
    return {};
  }
}

function ownerId(owner: Awaited<ReturnType<BrandOwnerService["resolve"]>> | null) {
  return owner?.company?.id ?? null;
}
