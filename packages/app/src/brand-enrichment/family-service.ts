import {
  FamilyFindingSchema,
  type FamilyFinding,
  type BrandFamilyPlan,
} from "@crawl-automation/v3-contracts";
import type { BrandEnrichmentRuns, BrandEnrichmentReviews, SupplySmartCompanies } from "./ports.js";
import type { FamilyCheck } from "./task-ports.js";
import { requireCompanyRun, saveOutput } from "./run-records.js";
import { BrandFamilyChildren } from "./family-children.js";

export class BrandFamilyService {
  constructor(
    private readonly deps: {
      runs: BrandEnrichmentRuns;
      reviews: BrandEnrichmentReviews;
      companies: SupplySmartCompanies;
      family: FamilyCheck;
      subBrandLimit: number;
    },
  ) {}
  async check(runId: string, signal: AbortSignal): Promise<BrandFamilyPlan> {
    const run = await requireCompanyRun(this.deps.runs, runId);
    if (run.role !== "request" || !run.brandUrl) {
      return { children: [], products: run.role === "sub_brand" && !!run.brandUrl };
    }
    const finding = FamilyFindingSchema.parse(await this.deps.family.check(run, signal));
    await saveOutput(this.deps.runs, {
      runId,
      step: "family",
      output: finding,
      archiveKeys: finding.archiveKeys,
    });
    await this.deps.runs.addClues(runId, finding.clues);
    await this.domains({ runId, companyId: run.companyId, finding }, signal);
    const { summary, children } = await new BrandFamilyChildren(this.deps).prepare(
      { run, finding },
      signal,
    );
    await saveOutput(this.deps.runs, { runId, step: "family-summary", output: summary });
    const eligible = finding.isNutrition && ["single", "shared_site"].includes(finding.shape);
    const unlinked =
      finding.shape === "shared_site" &&
      summary.subBrands.some((brand) => brand.status === "failed");
    return { children, products: eligible && !unlinked };
  }
  private async domains(
    input: { runId: string; companyId: string; finding: FamilyFinding },
    signal: AbortSignal,
  ) {
    const { runId, companyId, finding } = input;
    const domains = [...finding.otherDomains];
    const redirect = finding.redirect;
    if (redirect?.sameBrand) {
      domains.push(
        { domain: redirect.fromDomain, status: "former" },
        { domain: redirect.toDomain, status: "current" },
      );
    }
    if (!domains.length) {
      return;
    }
    const unique = [...new Map(domains.map((item) => [item.domain, item])).values()].slice(0, 50);
    const result = await this.deps.companies.addDomains({ companyId, domains: unique }, signal);
    await saveOutput(this.deps.runs, { runId, step: "domain-additions", output: result });
  }
}
