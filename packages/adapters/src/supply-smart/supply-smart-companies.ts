import type { LinkOutcome, SupplySmartCompanies } from "@crawl-automation/app";
import {
  BRAND_ENRICHMENT_SOURCE,
  CompanyEnrichmentResultSchema,
  CompanyLinkResultSchema,
  CompanyResolutionSchema,
  CompanySchema,
  DomainAdditionResultSchema,
  DomainResolutionSchema,
  OwnershipStatusSchema,
  type CompanyEnrichment,
  type CompanyFacts,
  type CompanyLink,
  type CompanyUnlink,
  type DomainAddition,
  type NewCompany,
  type OwnershipCheck,
} from "@crawl-automation/v3-contracts";
import { z } from "zod";
import {
  supplySmartStatus,
  type SupplySmartCall,
  type SupplySmartRpc,
} from "./supply-smart-rpc.js";

/** Companies on the product database gateway. Every write carries `source = brand_enrichment`. */
export class SupplySmartCompaniesClient implements SupplySmartCompanies {
  constructor(private readonly rpc: SupplySmartRpc) {}

  resolveDomain(domain: string, signal: AbortSignal) {
    return this.database(
      { path: "product.resolveCompany", input: { domain }, answer: DomainResolutionSchema },
      signal,
    );
  }

  resolve(facts: CompanyFacts, signal: AbortSignal) {
    return this.database(
      { path: "company.resolve", input: facts, answer: CompanyResolutionSchema },
      signal,
    );
  }

  get(companyId: string, signal: AbortSignal) {
    return this.database(
      { path: "company.getById", input: { id: companyId }, answer: CompanySchema },
      signal,
    );
  }

  create(company: NewCompany, signal: AbortSignal) {
    const input = { ...company, isVisible: true, apolloData: null };
    return this.database({ path: "company.create", input, answer: CompanySchema }, signal);
  }

  addDomains(addition: DomainAddition, signal: AbortSignal) {
    const input = { ...addition, source: BRAND_ENRICHMENT_SOURCE };
    return this.database(
      { path: "company.addDomains", input, answer: DomainAdditionResultSchema },
      signal,
    );
  }

  enrich(enrichment: CompanyEnrichment, signal: AbortSignal) {
    return this.database(
      {
        path: "company.enrich",
        input: enrichInput(enrichment),
        answer: CompanyEnrichmentResultSchema,
      },
      signal,
    );
  }

  async link(link: CompanyLink, signal: AbortSignal): Promise<LinkOutcome> {
    const input = { ...link, source: BRAND_ENRICHMENT_SOURCE };
    try {
      const result = await this.database(
        { path: "company.link", input, answer: CompanyLinkResultSchema },
        signal,
      );
      return { status: "linked", result };
    } catch (error) {
      if (supplySmartStatus(error) === 409) {
        return { status: "conflict", detail: (error as { details?: unknown }).details ?? null };
      }
      throw error;
    }
  }

  unlink(unlink: CompanyUnlink, signal: AbortSignal) {
    const input = { ...unlink, source: BRAND_ENRICHMENT_SOURCE };
    const answer = z.object({ status: z.enum(["removed", "missing"]) });
    return this.database({ path: "company.unlink", input, answer }, signal);
  }

  async recordOwnershipCheck(check: OwnershipCheck, signal: AbortSignal) {
    const input = { ...check, source: BRAND_ENRICHMENT_SOURCE };
    await this.database(
      { path: "company.recordOwnershipCheck", input, answer: z.unknown() },
      signal,
    );
  }

  ownershipStatus(companyId: string, signal: AbortSignal) {
    return this.database(
      { path: "company.ownershipStatus", input: { companyId }, answer: OwnershipStatusSchema },
      signal,
    );
  }

  private database<Schema extends z.ZodType>(
    call: Omit<SupplySmartCall<Schema>, "api">,
    signal: AbortSignal,
  ) {
    return this.rpc.call({ api: "database", ...call }, signal);
  }
}

/** `company/enrich` input: fill empty fields only, people stay on the brand, provenance on every write. */
function enrichInput(enrichment: CompanyEnrichment) {
  const { apollo, ...profile } = enrichment;
  return {
    ...profile,
    mode: "fill_empty",
    source: BRAND_ENRICHMENT_SOURCE,
    unknownEmployer: "keep",
    apolloPeople: apollo?.people ?? [],
    ...(apollo ? { apolloOrganization: apollo.organization, apolloMatch: apollo.match } : {}),
  };
}
