import { BrandWebsiteSchema, type BrandEnrichmentRun } from "@crawl-automation/v3-contracts";
import type { SupplySmartCompanies, BrandEnrichmentRuns, BrandEnrichmentReviews } from "./ports.js";
import { domainOf, requireRun, saveOutput } from "./run-records.js";
import { resolvedCompany } from "./company-resolution.js";
import { existingBrandCompany } from "./identity-status.js";
import { identityCandidates, registrableDomain } from "./identity-candidates.js";
import { brandEnrichmentErrors } from "./errors.js";

export class BrandIdentityService {
  constructor(
    private readonly deps: {
      companies: SupplySmartCompanies;
      runs: BrandEnrichmentRuns;
      /** Where a marketplace brand's look-alike companies wait for a person (owner 2026-10-15). */
      reviews?: Pick<BrandEnrichmentReviews, "addQuestion">;
    },
  ) {}
  async resolve(runId: string, signal: AbortSignal) {
    const run = await requireRun(this.deps.runs, runId);
    await this.deps.runs.update(runId, { stage: "identity" });
    if (run.companyId) {
      const company = await this.deps.companies.get(run.companyId, signal);
      await saveOutput(this.deps.runs, { runId, step: "identity-company", output: company });
      return { company, existing: await existingBrandCompany(this.deps.runs, runId) };
    }
    const domain = domainOf(run.brandUrl);
    const resolution = domain
      ? await this.resolveDomain(domain, signal)
      : await this.deps.companies.resolve({ name: run.brandName }, signal);
    await saveOutput(this.deps.runs, { runId, step: "identity-resolution", output: resolution });
    const owner = await this.websiteOwner(run);
    if (resolution.status === "unmatched" && domain && run.role === "marketplace") {
      await this.holdLookalikes(run, { domain, owner }, signal);
    }
    const company = await resolvedCompany(
      this.deps.companies,
      {
        resolution,
        create: {
          name: owner ?? run.brandName,
          ...(domain ? { website: `https://${domain}` } : {}),
          isNutrition: run.role !== "owner",
        },
      },
      signal,
    );
    await this.deps.runs.update(runId, { companyId: company.id });
    await saveOutput(this.deps.runs, { runId, step: "identity-company", output: company });
    return { company, existing: resolution.status === "matched" };
  }

  /** A regional or shop subdomain (`us.myprotein.com`) is also looked up as its registrable domain (owner 2026-10-15). */
  private async resolveDomain(domain: string, signal: AbortSignal) {
    const resolution = await this.deps.companies.resolveDomain(domain, signal);
    const root = resolution.status === "unmatched" ? registrableDomain(domain) : null;
    if (!root) {
      return resolution;
    }
    const byRoot = await this.deps.companies.resolveDomain(root, signal);
    return byRoot.status === "unmatched" ? resolution : byRoot;
  }

  /**
   * Owner 2026-10-15: an existing company under another site or spelling must not get a duplicate. Look-alikes become
   * one question for a person and the run stops before creating anything; the brand keeps waiting.
   */
  private async holdLookalikes(
    run: BrandEnrichmentRun,
    found: { domain: string; owner: string | undefined },
    signal: AbortSignal,
  ) {
    const names = [run.brandName, ...(found.owner ? [found.owner] : [])];
    const candidates = await identityCandidates(
      this.deps.companies,
      { names, domain: found.domain },
      signal,
    );
    if (!candidates.length) {
      return;
    }
    const question = {
      brandId: run.brandId ?? null,
      brandName: run.brandName,
      owner: found.owner ?? null,
      website: run.brandUrl,
      domain: found.domain,
      candidates,
    };
    await saveOutput(this.deps.runs, {
      runId: run.runId,
      step: "identity-candidates",
      output: question,
    });
    const asked = await this.deps.reviews?.addQuestion(run.runId, "identity", question);
    throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.IDENTITY_CANDIDATES", {
      details: { questionId: asked?.questionId ?? null, candidates: candidates.length },
    });
  }

  /** A marketplace brand found only through its owner's site creates the owner's company (owner 2026-10-15). */
  private async websiteOwner(run: BrandEnrichmentRun): Promise<string | undefined> {
    if (run.role !== "marketplace") {
      return undefined;
    }
    const website = BrandWebsiteSchema.safeParse(await this.deps.runs.step(run.runId, "website"));
    return website.success ? website.data.owner?.name : undefined;
  }
}
