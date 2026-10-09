import type { BrandEnrichmentRun, ReviewerVerdict, Company } from "@crawl-automation/v3-contracts";
import type { BrandEnrichmentRuns, BrandEnrichmentReviews, SupplySmartCompanies } from "./ports.js";
import { resolveOwnerCompany, resolvedCompany } from "./company-resolution.js";
import { childRun, domainOf, saveOutput } from "./run-records.js";
type OwnerVerdict = Extract<ReviewerVerdict, { verdict: "owner" }>;
export class BrandOwnerService {
  constructor(
    private readonly deps: {
      runs: BrandEnrichmentRuns;
      reviews: BrandEnrichmentReviews;
      companies: SupplySmartCompanies;
    },
  ) {}
  async resolve(verdict: OwnerVerdict, signal: AbortSignal) {
    const domain = domainOf(verdict.ownerDomain);
    const resolution = await resolveOwnerCompany(
      this.deps.companies,
      { name: verdict.ownerName, ...(domain ? { domain } : {}) },
      signal,
    );
    if (resolution.status === "ambiguous") {
      return { resolution, company: null, created: false };
    }
    const company = await resolvedCompany(
      this.deps.companies,
      {
        resolution,
        create: {
          name: verdict.ownerName,
          isNutrition: false,
          ...(domain ? { website: `https://${domain}` } : {}),
        },
      },
      signal,
    );
    return { resolution, company, created: resolution.status === "unmatched" };
  }
  async prepare(input: {
    run: BrandEnrichmentRun;
    company: Company;
    created: boolean;
    verdict: OwnerVerdict;
  }) {
    const { run, company, verdict } = input;
    await this.possibleMerge(input);
    await saveOutput(this.deps.runs, {
      runId: run.runId,
      step: "ownership-link",
      output: {
        fromCompanyId: run.companyId,
        toCompanyId: company.id,
        kind: verdict.kind,
        confidence: verdict.confidence,
      },
    });
    if (!input.created) {
      return {};
    }
    const child = await childRun(this.deps.runs, {
      parent: run,
      role: "owner",
      name: company.name,
      url: company.website,
      companyId: company.id,
    });
    return { ownerRunId: child.runId };
  }
  private async possibleMerge(input: {
    run: BrandEnrichmentRun;
    company: Company;
    verdict: OwnerVerdict;
  }) {
    const { run, company, verdict } = input;
    const clues = await this.deps.runs.clues(run.runId);
    const holder = clues.find(
      (clue) =>
        clue.signal === "shared_apollo_org" &&
        clue.ownerCompanyId &&
        clue.ownerCompanyId !== company.id,
    );
    if (holder) {
      await this.deps.reviews.addQuestion(run.runId, "merge", {
        holderCompanyId: holder.ownerCompanyId,
        ownerCompanyId: company.id,
        reason: verdict.reason,
      });
    }
  }
}
