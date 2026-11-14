import type { Company } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import type { BrandEnrichmentRuns, SupplySmartCompanies } from "../brand-enrichment/ports.js";
import {
  BRAND_COMPANY_REFRESH_MS,
  brandCompanyDomain,
  type MatchBrandsResult,
  type MatchChange,
  type MatchRefreshResult,
  type NamedBrandCompanyMatch,
} from "./brand-company-model.js";
import type { BrandCompanyRepository } from "./ports.js";

type Errors = MatchBrandsResult["errors"];

/**
 * Owner 2026-11-14: matched brands read against their company again, least recently checked first, one read per
 * company (2026-11-14: of 2,207 matched brands 10 had a merged company, 79 products refused with `company_conflict`;
 * 20 companies had changed their website).
 *
 * - A merged company: reading it answers with the survivor. When the read itself is refused, the brand's domain is
 *   asked instead, and the company that owns it now (a merged company's domains move to the survivor) is read.
 * - The brand then carries the company's current website as its domain, as a first match does.
 * - Nothing changes unless Supply Smart resolves that domain to that very company; otherwise the brand is reported.
 */
export class BrandCompanyRefresh {
  constructor(
    private readonly deps: {
      brands: Pick<BrandCompanyRepository, "staleMatches" | "upsert">;
      companies: Pick<SupplySmartCompanies, "get" | "resolveDomain">;
      /** Website runs follow a merged company to its survivor, as an owner-approved merge does. */
      runs?: Pick<BrandEnrichmentRuns, "moveCompany">;
      now: () => Date;
    },
  ) {}

  async refresh(
    at: { limit: number; checkedBefore?: string | undefined },
    errors: Errors,
    signal: AbortSignal,
  ): Promise<MatchRefreshResult> {
    const checkedBefore =
      at.checkedBefore ??
      new Date(this.deps.now().getTime() - BRAND_COMPANY_REFRESH_MS).toISOString();
    const stale = await this.deps.brands.staleMatches({ limit: at.limit, checkedBefore });
    const result: MatchRefreshResult = {
      checked: 0,
      merged: 0,
      website: 0,
      unchanged: 0,
      changes: [],
    };
    for (const [companyId, matches] of byCompany(stale)) {
      signal.throwIfAborted();
      result.checked += matches.length;
      try {
        await this.company({ companyId, matches }, result, signal);
      } catch (error) {
        signal.throwIfAborted();
        report(errors, matches, String(error));
      }
    }
    return result;
  }

  private async company(
    { companyId, matches }: { companyId: string; matches: NamedBrandCompanyMatch[] },
    result: MatchRefreshResult,
    signal: AbortSignal,
  ) {
    const company = await this.current(companyId, matches, signal);
    const survivor = z.uuid().parse(company.id);
    const website = brandCompanyDomain(company.website);
    const checkedAt = this.deps.now().toISOString();
    const planned = matches.map(({ name, ...match }) => {
      const to = { companyId: survivor, domain: website ?? match.domain };
      const kind: MatchChange["kind"] | null =
        survivor !== companyId ? "merged" : to.domain !== match.domain ? "website" : null;
      return { name, match, to, kind };
    });
    const changed = [...new Set(planned.filter(({ kind }) => kind).map(({ to }) => to.domain))];
    for (const domain of changed) {
      await this.confirm(domain, survivor, signal);
    }
    for (const { name, match, to, kind } of planned) {
      await this.deps.brands.upsert({ ...match, ...to, checkedAt });
      result[kind ?? "unchanged"] += 1;
      if (kind) {
        const from = { companyId: match.companyId, domain: match.domain };
        result.changes.push({ brandId: match.brandId, name, kind, from, to });
      }
    }
    if (survivor !== companyId) {
      await this.deps.runs?.moveCompany(companyId, survivor);
    }
  }

  /** The company as Supply Smart has it now; a refused read falls back to the owner of the brand's domain. */
  private async current(
    companyId: string,
    matches: NamedBrandCompanyMatch[],
    signal: AbortSignal,
  ): Promise<Company> {
    try {
      return await this.deps.companies.get(z.uuid().parse(companyId), signal);
    } catch (error) {
      signal.throwIfAborted();
      const domain = matches.find((match) => match.domain)?.domain;
      const owner = domain ? await this.deps.companies.resolveDomain(domain, signal) : null;
      if (owner?.status !== "matched" || !owner.companyId) {
        const answer = owner ? `${owner.status}: ${owner.reason}` : "no domain";
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; domain ${domain ?? "-"} resolves to no company (${answer})`,
          {
            cause: error,
          },
        );
      }
      return this.deps.companies.get(z.uuid().parse(owner.companyId), signal);
    }
  }

  /** The domain a brand is about to carry must resolve to the company it is about to be matched to. */
  private async confirm(domain: string | null, companyId: string, signal: AbortSignal) {
    const owner = domain ? await this.deps.companies.resolveDomain(domain, signal) : null;
    if (owner?.status !== "matched" || owner.companyId !== companyId) {
      const answer = owner ? `${owner.status} ${owner.companyId ?? ""}`.trim() : "no domain";
      throw new Error(
        `PRODUCT_SYNC.REFRESH_UNCONFIRMED: ${domain ?? "-"} resolves to ${answer}, not ${companyId}`,
      );
    }
  }
}

function byCompany(stale: NamedBrandCompanyMatch[]) {
  const groups = new Map<string, NamedBrandCompanyMatch[]>();
  for (const match of stale) {
    const key = match.companyId ?? "";
    groups.set(key, [...(groups.get(key) ?? []), match]);
  }
  return groups;
}

function report(errors: Errors, matches: NamedBrandCompanyMatch[], message: string) {
  const error = message.slice(0, 1000);
  errors.push(...matches.map(({ brandId, name }) => ({ brandId, name, error })));
}
