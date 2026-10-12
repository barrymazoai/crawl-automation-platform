import { z } from "zod";
import type { SupplySmartCompanies } from "../brand-enrichment/ports.js";
import { brandCompanyErrors } from "./brand-company-errors.js";
import {
  BRAND_COMPANY_CANDIDATE_LIMIT,
  BRAND_COMPANY_RECHECK_MS,
  ListSyncBrandsSchema,
  MatchBrandsSchema,
  brandCompanyDomain,
  type BrandCompanyMatch,
  type MatchBrandsResult,
  type SyncBrand,
} from "./brand-company-model.js";
import type { BrandCompanyRepository } from "./ports.js";

/** Read-only Supply Smart operations; no company creation or product ingestion in this step. */
export class BrandCompanyService {
  constructor(
    private readonly deps: {
      brands: BrandCompanyRepository;
      companies: Pick<SupplySmartCompanies, "resolve" | "get">;
      now?: () => Date;
    },
  ) {}

  async matchBrands(
    raw: unknown,
    signal = new AbortController().signal,
  ): Promise<MatchBrandsResult> {
    const input = MatchBrandsSchema.parse(raw);
    signal.throwIfAborted();
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
