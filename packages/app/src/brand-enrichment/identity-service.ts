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
          name: run.brandName,
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
}
