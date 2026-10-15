import type { CompanyMerge, CompanyRename } from "@crawl-automation/v3-contracts";
import type { BrandCompanyRepository } from "../product-sync/ports.js";
import type { BrandEnrichmentRuns, SupplySmartCompanies } from "./ports.js";
import { brandEnrichmentErrors } from "./errors.js";

/**
 * Owner-approved corrections of companies the marketplace runs created (owner 2026-10-15). Nothing calls these
 * automatically. A merge is Supply Smart's own `company.mergeCompany` (products, contacts and domains move to the
 * survivor; the source is deleted); our brand matches and runs then point at the survivor, so the product sync sends
 * under it.
 */
export class CompanyCorrectionService {
  constructor(
    private readonly deps: {
      companies: SupplySmartCompanies;
      runs: Pick<BrandEnrichmentRuns, "moveCompany">;
      matches?: Pick<BrandCompanyRepository, "moveCompany">;
    },
  ) {}

  rename(rename: CompanyRename, signal = new AbortController().signal) {
    return this.deps.companies.rename(rename, signal);
  }

  async merge(merge: CompanyMerge, signal = new AbortController().signal) {
    if (merge.survivorId === merge.sourceId) {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.INVALID_MATCH", {
        details: { reason: "same_company" },
      });
    }
    if (!this.deps.matches) {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.NOT_CONFIGURED");
    }
    const result = await this.deps.companies.merge(merge, signal);
    if (merge.dryRun) {
      return { merge: result, moved: null };
    }
    const matches = await this.deps.matches.moveCompany(merge.sourceId, merge.survivorId);
    const runs = await this.deps.runs.moveCompany(merge.sourceId, merge.survivorId);
    return { merge: result, moved: { matches, runs } };
  }
}
