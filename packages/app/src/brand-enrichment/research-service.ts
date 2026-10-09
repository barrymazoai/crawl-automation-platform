import { BrandResearchSchema } from "@crawl-automation/v3-contracts";
import type { BrandEnrichmentRuns, SupplySmartCompanies } from "./ports.js";
import type { BrandResearcher } from "./task-ports.js";
import { requireCompanyRun, saveOutput } from "./run-records.js";

export class BrandResearchService {
  constructor(
    private readonly deps: {
      runs: BrandEnrichmentRuns;
      companies: SupplySmartCompanies;
      researcher: BrandResearcher;
    },
  ) {}
  async research(runId: string, signal: AbortSignal) {
    const run = await requireCompanyRun(this.deps.runs, runId);
    const status = await this.deps.companies.ownershipStatus(run.companyId, signal);
    await saveOutput(this.deps.runs, { runId, step: "ownership-status", output: status });
    const skipOwnershipResearch =
      run.role === "owner" || status.owners.length > 0 || status.latestCheck !== null;
    // Structural extension is passed to the task factory; frozen BrandSubject needs this optional flag upstream.
    const subject = { ...run, skipOwnershipResearch };
    const result = BrandResearchSchema.parse(await this.deps.researcher.research(subject, signal));
    await saveOutput(this.deps.runs, {
      runId,
      step: "research",
      output: result,
      archiveKeys: result.archiveKeys,
    });
    await this.deps.runs.addClues(runId, result.clues);
    return result;
  }
}
