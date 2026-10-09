import {
  CompanyLinkSchema,
  OwnershipStatusSchema,
  ReviewerVerdictSchema,
} from "@crawl-automation/v3-contracts";
import { z } from "zod";
import type { BrandEnrichmentRuns, BrandEnrichmentReviews, SupplySmartCompanies } from "./ports.js";
import { saveOutput } from "./run-records.js";
import { saveOwnershipConflict } from "./ownership-conflict.js";
import { BrandWriteService } from "./write-service.js";

export class BrandOwnershipWriteService {
  constructor(
    private readonly deps: {
      runs: BrandEnrichmentRuns;
      reviews: BrandEnrichmentReviews;
      companies: SupplySmartCompanies;
    },
  ) {}
  async write(runId: string, signal: AbortSignal) {
    const raw = await this.deps.runs.step(runId, "ownership-link");
    if (!raw) {
      return this.existingParent(runId, signal);
    }
    const link = CompanyLinkSchema.parse(raw);
    const { verdict, decisionId } = z
      .object({ verdict: ReviewerVerdictSchema, decisionId: z.uuid() })
      .parse(await this.deps.runs.step(runId, "verdict"));
    const outcome = await this.deps.companies.link(link, signal);
    if (outcome.status === "conflict") {
      await saveOwnershipConflict(this.deps.runs, { runId, link, detail: outcome.detail });
      return;
    }
    await this.deps.companies.recordOwnershipCheck(
      {
        companyId: link.fromCompanyId,
        result: "has_parent",
        signals: verdict.verdict === "owner" ? verdict.signals : [],
        note: verdict.reason.slice(0, 2000),
      },
      signal,
    );
    await this.deps.reviews.markDecisionSent(decisionId, { link, result: outcome.result });
    await saveOutput(this.deps.runs, { runId, step: "ownership", output: "has_parent" });
    await new BrandWriteService(this.deps).writeParent(
      { runId, companyId: link.toCompanyId },
      signal,
    );
  }
  private async existingParent(runId: string, signal: AbortSignal) {
    const status = OwnershipStatusSchema.safeParse(
      await this.deps.runs.step(runId, "ownership-status"),
    );
    if (!status.success) {
      return;
    }
    const owners = [...new Set(status.data.owners.map((owner) => owner.toCompanyId))];
    const companyId = owners.length === 1 ? owners[0] : undefined;
    if (companyId) {
      await new BrandWriteService(this.deps).writeParent({ runId, companyId }, signal);
    }
  }
}
