import { BrandResearchSchema, CompanyEnrichmentResultSchema } from "@crawl-automation/v3-contracts";
import type { BrandEnrichmentRuns, SupplySmartCompanies } from "./ports.js";
import { BrandApolloResultSchema } from "./apollo-service.js";
import { requireCompanyRun, saveOutput, domainOf } from "./run-records.js";
import { brandEnrichmentErrors } from "./errors.js";

/** One decided enrichment write per run; fill-empty policy belongs to the Supply Smart adapter. */
export class BrandWriteService {
  constructor(
    private readonly deps: { runs: BrandEnrichmentRuns; companies: SupplySmartCompanies },
  ) {}
  async write(runId: string, signal: AbortSignal) {
    const run = await requireCompanyRun(this.deps.runs, runId);
    const research = BrandResearchSchema.parse(await this.deps.runs.step(runId, "research"));
    const match = BrandApolloResultSchema.parse(await this.deps.runs.step(runId, "apollo"));
    const result = CompanyEnrichmentResultSchema.parse(
      await this.deps.companies.enrich(
        {
          companyId: run.companyId,
          ...(research.description ? { description: research.description } : {}),
          keywords: research.keywords,
          ...(research.category ? { categories: [research.category] } : {}),
          evidence: research.evidence,
          ...(match.status === "matched" && match.apollo ? { apollo: match.apollo } : {}),
        },
        signal,
      ),
    );
    await saveOutput(this.deps.runs, { runId, step: "write", output: result });
    if (!result.matched) {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.IDENTITY_UNRESOLVED");
    }
    if (result.apolloOrganizationHeldBy) {
      const holder = await this.deps.companies.get(result.apolloOrganizationHeldBy, signal);
      await this.deps.runs.addClues(runId, [
        {
          signal: "shared_apollo_org",
          ownerName: holder.name,
          ownerDomain: domainOf(holder.website),
          ownerCompanyId: holder.id,
          quote: `Apollo organization ${match.apollo?.organization.id ?? ""} is already held by this company`,
          url: null,
          archiveKey: null,
        },
      ]);
    }
    return result;
  }
  /** Only a confirmed parent's organization is written here; the brand write never borrows it. */
  async writeParent(input: { runId: string; companyId: string }, signal: AbortSignal) {
    const { runId, companyId } = input;
    const match = BrandApolloResultSchema.safeParse(await this.deps.runs.step(runId, "apollo"));
    if (!match.success || match.data.status !== "parent_only" || !match.data.apollo) {
      return;
    }
    const company = await this.deps.companies.get(companyId, signal);
    if (company.apolloOrganizationId === match.data.apollo.organization.id) {
      await saveOutput(this.deps.runs, {
        runId,
        step: "parent-apollo-write",
        output: { companyId, status: "already_held" },
      });
      return;
    }
    const result = CompanyEnrichmentResultSchema.parse(
      await this.deps.companies.enrich({ companyId, apollo: match.data.apollo }, signal),
    );
    await saveOutput(this.deps.runs, {
      runId,
      step: "parent-apollo-write",
      output: result,
    });
    if (!result.matched) {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.IDENTITY_UNRESOLVED");
    }
  }
}
