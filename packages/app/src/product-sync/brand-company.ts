import { z } from "zod";
import type { BrandEnrichmentRuns, SupplySmartCompanies } from "../brand-enrichment/ports.js";
import { brandCompanyErrors } from "./brand-company-errors.js";
import {
  BRAND_COMPANY_CANDIDATE_LIMIT,
  BRAND_COMPANY_RECHECK_MS,
  BRAND_COMPANY_REFRESH_MS,
  ListSyncBrandsSchema,
  MatchBrandsSchema,
  brandCompanyDomain,
  type BrandCompanyMatch,
  type MatchBrandsResult,
  type MatchChange,
  type MatchRefreshResult,
  type NamedBrandCompanyMatch,
  type SyncBrand,
} from "./brand-company-model.js";
import type { BrandCompanyRepository } from "./ports.js";

/** Read-only Supply Smart operations; no company creation or product ingestion in this step. */
export class BrandCompanyService {
  constructor(
    private readonly deps: {
      brands: BrandCompanyRepository;
      companies: Pick<SupplySmartCompanies, "resolve" | "get">;
      /** Website runs follow a merged company to its survivor, as an owner-approved merge does. */
      runs?: Pick<BrandEnrichmentRuns, "moveCompany">;
      now?: () => Date;
    },
  ) {}

  async matchBrands(
    raw: unknown,
    signal = new AbortController().signal,
  ): Promise<MatchBrandsResult> {
    const input = MatchBrandsSchema.parse(raw);
    signal.throwIfAborted();
    const result = await this.matchUnmatched(input, signal);
    if (input.refreshMatched) {
      result.refreshed = await this.refresh(input.refreshMatched, result.errors, signal);
    }
    return result;
  }

  /** Brands never checked, or not matched and due (or asked) for another look. */
  private async matchUnmatched(
    input: z.infer<typeof MatchBrandsSchema>,
    signal: AbortSignal,
  ): Promise<MatchBrandsResult> {
    const checkedBefore = new Date(this.now().getTime() - BRAND_COMPANY_RECHECK_MS).toISOString();
    const brands = await this.deps.brands.candidates({
      limit: input.limit,
      checkedBefore,
      recheckUnmatched: input.recheckUnmatched ?? false,
    });
    const result: MatchBrandsResult = {
      checked: 0,
      matched: 0,
      ambiguous: 0,
      unmatched: 0,
      errors: [],
    };
    for (const brand of brands.slice(0, input.limit)) {
      signal.throwIfAborted();
      if (!this.shouldCheck(brand, checkedBefore, input.recheckUnmatched ?? false)) {
        continue;
      }
      result.checked += 1;
      try {
        const status = await this.check(brand, signal);
        result[status] += 1;
      } catch (error) {
        signal.throwIfAborted();
        result.errors.push({
          brandId: brand.brandId,
          name: brand.name,
          error: String(error).slice(0, 1000),
        });
      }
    }
    signal.throwIfAborted();
    return result;
  }

  brands(raw: unknown) {
    const { status, limit } = ListSyncBrandsSchema.parse(raw);
    return this.deps.brands.list({ limit, ...(status ? { status } : {}) });
  }

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * Matched brands read against their company again, one read per company. A company Supply Smart merged answers
   * with its survivor (2026-11-14: 10 of 2,207 brands, 79 products refused with `company_conflict`); 20 more
   * companies had changed their website. A refused read changes nothing and is reported.
   */
  private async refresh(
    at: { limit: number; checkedBefore?: string | undefined },
    errors: MatchBrandsResult["errors"],
    signal: AbortSignal,
  ): Promise<MatchRefreshResult> {
    const checkedBefore =
      at.checkedBefore ?? new Date(this.now().getTime() - BRAND_COMPANY_REFRESH_MS).toISOString();
    const stale = await this.deps.brands.staleMatches({ limit: at.limit, checkedBefore });
    const result: MatchRefreshResult = {
      checked: 0,
      merged: 0,
      website: 0,
      unchanged: 0,
      changes: [],
    };
    const byCompany = new Map<string, NamedBrandCompanyMatch[]>();
    for (const match of stale) {
      const key = match.companyId ?? "";
      byCompany.set(key, [...(byCompany.get(key) ?? []), match]);
    }
    for (const [companyId, matches] of byCompany) {
      signal.throwIfAborted();
      result.checked += matches.length;
      try {
        await this.refreshCompany({ companyId, matches }, result, signal);
      } catch (error) {
        signal.throwIfAborted();
        const message = String(error).slice(0, 1000);
        errors.push(...matches.map(({ brandId, name }) => ({ brandId, name, error: message })));
      }
    }
    return result;
  }

  private async refreshCompany(
    { companyId, matches }: { companyId: string; matches: NamedBrandCompanyMatch[] },
    result: MatchRefreshResult,
    signal: AbortSignal,
  ) {
    const company = await this.deps.companies.get(z.uuid().parse(companyId), signal);
    signal.throwIfAborted();
    const survivor = z.uuid().parse(company.id);
    const website = brandCompanyDomain(company.website);
    const checkedAt = this.now().toISOString();
    for (const { name, ...match } of matches) {
      const domain = website ?? match.domain;
      const change: MatchChange["kind"] | null =
        survivor !== companyId ? "merged" : domain !== match.domain ? "website" : null;
      await this.deps.brands.upsert({ ...match, companyId: survivor, domain, checkedAt });
      result[change ?? "unchanged"] += 1;
      if (change) {
        const from = { companyId: match.companyId, domain: match.domain };
        result.changes.push({
          brandId: match.brandId,
          name,
          kind: change,
          from,
          to: { companyId: survivor, domain },
        });
      }
    }
    if (survivor !== companyId) {
      await this.deps.runs?.moveCompany(companyId, survivor);
    }
  }

  private async check(brand: SyncBrand, signal: AbortSignal) {
    const match = await this.resolve(brand, signal);
    signal.throwIfAborted();
    await this.deps.brands.upsert(match);
    return match.status;
  }

  private shouldCheck(brand: SyncBrand, checkedBefore: string, recheck: boolean) {
    return (
      !brand.match ||
      (brand.match.status !== "matched" &&
        (recheck || Date.parse(brand.match.checkedAt) <= Date.parse(checkedBefore)))
    );
  }

  private async resolve(brand: SyncBrand, signal: AbortSignal): Promise<BrandCompanyMatch> {
    const resolution = await this.deps.companies.resolve(
      {
        name: brand.name,
        ...(brand.dtcDomain ? { domain: brand.dtcDomain } : {}),
      },
      signal,
    );
    signal.throwIfAborted();
    const base = {
      brandId: brand.brandId,
      companyId: null,
      domain: null,
      matchedBy: resolution.matchedBy,
      candidates: [],
      checkedAt: this.now().toISOString(),
    };
    if (resolution.status === "matched") {
      const companyId = z.uuid().parse(resolution.companyId);
      const company = await this.deps.companies.get(companyId, signal);
      signal.throwIfAborted();
      if (company.id !== companyId) {
        throw brandCompanyErrors.create("PRODUCT_SYNC.INVALID_COMPANY");
      }
      const domain = brandCompanyDomain(company.website);
      return domain
        ? { ...base, status: "matched", companyId, domain }
        : { ...base, status: "unmatched", matchedBy: "no_website" };
    }
    const candidates =
      resolution.status === "ambiguous"
        ? [...new Set(resolution.matches.map((match) => z.uuid().parse(match.companyId)))].slice(
            0,
            BRAND_COMPANY_CANDIDATE_LIMIT,
          )
        : [];
    return { ...base, status: resolution.status, candidates };
  }
}
