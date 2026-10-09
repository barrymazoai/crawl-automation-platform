import type {
  CompanyFacts,
  NewCompany,
  CompanyResolution,
  DomainResolution,
} from "@crawl-automation/v3-contracts";
import type { SupplySmartCompanies } from "./ports.js";
import { brandEnrichmentErrors } from "./errors.js";

/** Shared identity rule: ambiguity/conflict is data, never an instruction to create or choose a candidate. */
export async function resolvedCompany(
  companies: SupplySmartCompanies,
  input: {
    resolution: CompanyResolution | DomainResolution;
    create: NewCompany;
  },
  signal: AbortSignal,
) {
  if (input.resolution.status === "unmatched") {
    return companies.create(input.create, signal);
  }
  if (input.resolution.status === "matched" && input.resolution.companyId) {
    return companies.get(input.resolution.companyId, signal);
  }
  throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.IDENTITY_UNRESOLVED", {
    details: { resolution: input.resolution },
  });
}
export async function resolveOwnerCompany(
  companies: SupplySmartCompanies,
  facts: CompanyFacts,
  signal: AbortSignal,
) {
  const resolution = facts.domain
    ? await companies.resolve({ domain: facts.domain }, signal)
    : null;
  if (resolution && resolution.status !== "unmatched") {
    return resolution;
  }
  return companies.resolve(facts.name ? { name: facts.name } : facts, signal);
}
