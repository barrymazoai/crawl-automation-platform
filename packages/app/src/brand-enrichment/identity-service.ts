import { BrandWebsiteSchema, type BrandEnrichmentRun } from "@crawl-automation/v3-contracts";
import type { SupplySmartCompanies, BrandEnrichmentRuns } from "./ports.js";
import { domainOf, requireRun, saveOutput } from "./run-records.js";
import { resolvedCompany } from "./company-resolution.js";
import { existingBrandCompany } from "./identity-status.js";

export class BrandIdentityService {
  constructor(
    private readonly deps: { companies: SupplySmartCompanies; runs: BrandEnrichmentRuns },
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
      ? await this.deps.companies.resolveDomain(domain, signal)
      : await this.deps.companies.resolve({ name: run.brandName }, signal);
    await saveOutput(this.deps.runs, { runId, step: "identity-resolution", output: resolution });
    const company = await resolvedCompany(
      this.deps.companies,
      {
        resolution,
        create: {
          name: (await this.websiteOwner(run)) ?? run.brandName,
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

  /** A marketplace brand found only through its owner's site creates the owner's company (owner 2026-10-15). */
  private async websiteOwner(run: BrandEnrichmentRun): Promise<string | undefined> {
    if (run.role !== "marketplace") {
      return undefined;
    }
    const website = BrandWebsiteSchema.safeParse(await this.deps.runs.step(run.runId, "website"));
    return website.success ? website.data.owner?.name : undefined;
  }
}
