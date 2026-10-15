import type { BrandEnrichmentQuestion } from "@crawl-automation/v3-contracts";
import type { BrandCompanyRepository } from "../product-sync/ports.js";
import type { BrandEnrichmentRuns, SupplySmartCompanies } from "./ports.js";
import type { IdentityCandidate } from "./identity-candidates.js";
import { brandEnrichmentErrors } from "./errors.js";
import { requireRun } from "./run-records.js";

type IdentityAnswer =
  { action: "same"; companyId: string; reason: string } | { action: "new"; reason: string };

interface IdentityQuestion {
  brandId: string | null;
  brandName: string;
  owner: string | null;
  domain: string;
  candidates: IdentityCandidate[];
}

/**
 * Owner 2026-10-15: a person answers a marketplace brand's look-alike question. "same" links the brand to that
 * listed company and adds the found domain to it, so the next lookup of that domain finds it; "new" creates the
 * company the run held back. Either way the brand's match is written and the product sync sends its products.
 */
export class IdentityAnswerService {
  constructor(
    private readonly deps: {
      runs: BrandEnrichmentRuns;
      companies: SupplySmartCompanies;
      matches?: Pick<BrandCompanyRepository, "upsert">;
      now?: () => Date;
    },
  ) {}

  async apply(
    question: BrandEnrichmentQuestion,
    answer: IdentityAnswer,
    signal: AbortSignal,
  ): Promise<{ companyId: string }> {
    const asked = question.question as unknown as IdentityQuestion;
    if (!this.deps.matches || !asked.brandId) {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.INVALID_STATE", {
        details: { questionId: question.questionId, reason: "not_a_marketplace_identity" },
      });
    }
    const companyId =
      answer.action === "same"
        ? await this.same(asked, answer.companyId, signal)
        : await this.created(asked, signal);
    await this.deps.matches.upsert({
      brandId: asked.brandId,
      status: "matched",
      companyId,
      domain: asked.domain,
      matchedBy: answer.action === "same" ? "person" : "person_new",
      candidates: [],
      checkedAt: (this.deps.now?.() ?? new Date()).toISOString(),
    });
    const run = await requireRun(this.deps.runs, question.runId);
    await this.deps.runs.update(run.runId, {
      companyId,
      summary: {
        ...run.summary,
        identity: answer.action === "same" ? "person_same" : "person_new",
      },
    });
    return { companyId };
  }

  private async created(asked: IdentityQuestion, signal: AbortSignal) {
    const company = await this.deps.companies.create(
      {
        name: asked.owner ?? asked.brandName,
        website: `https://${asked.domain}`,
        isNutrition: true,
      },
      signal,
    );
    return company.id;
  }

  private async same(asked: IdentityQuestion, companyId: string, signal: AbortSignal) {
    if (!asked.candidates.some((candidate) => candidate.companyId === companyId)) {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.INVALID_MATCH", {
        details: { companyId, reason: "not_a_listed_candidate" },
      });
    }
    await this.deps.companies.addDomains(
      { companyId, domains: [{ domain: asked.domain, status: "current" }] },
      signal,
    );
    return companyId;
  }
}
