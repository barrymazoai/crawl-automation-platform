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
import type { BrandCompanyRepository, ProductCompanies } from "./ports.js";

type Errors = MatchBrandsResult["errors"];

/** Sent products read to find a merged company's survivor; all of them must belong to one company. */
const PRODUCT_SAMPLE = 10;

/**
 * Owner 2026-11-14: matched brands read against their company again, least recently checked first, one read per
 * company (2026-11-14: of 2,207 matched brands 10 had a merged company, 79 products refused with `company_conflict`;
 * 20 companies had changed their website).
 *
 * - A merged company: reading it answers with the survivor. When the read itself is refused, the brand's domain is
 *   asked instead, and the company that owns it now (a merged company's domains move to the survivor) is read. When
 *   no company owns the domain either, the company that now holds every product we sent for the brand is taken
 *   (OP2 Labs → Frog Fuel and AkPharma → Prelief, 2026-11-14: their merges moved the products but neither the id
 *   nor the domain).
 * - The brand then carries the company's current website as its domain, as a first match does.
 * - Nothing changes unless Supply Smart resolves that domain to that very company; otherwise the brand is reported.
 */
export class BrandCompanyRefresh {
  constructor(
    private readonly deps: {
      brands: Pick<BrandCompanyRepository, "staleMatches" | "upsert" | "deliveredProducts">;
      companies: Pick<SupplySmartCompanies, "get" | "resolveDomain">;
      products?: ProductCompanies;
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

  /**
   * The company as Supply Smart has it now. A refused read falls back to the owner of the brand's domain, then to the
   * one company holding the products we sent for its brands.
   */
  private async current(
    companyId: string,
    matches: NamedBrandCompanyMatch[],
    signal: AbortSignal,
  ): Promise<Company> {
    try {
      return await this.deps.companies.get(z.uuid().parse(companyId), signal);
    } catch (error) {
      signal.throwIfAborted();
      const byDomain = await this.domainOwner(matches, signal);
      const found = byDomain.id ? byDomain : await this.productOwner(matches, signal);
      if (!found.id) {
        const read = error instanceof Error ? error.message : String(error);
        throw new Error(`${read}; ${byDomain.why}; ${found.why}`, { cause: error });
      }
      return this.deps.companies.get(z.uuid().parse(found.id), signal);
    }
  }

  private async domainOwner(matches: NamedBrandCompanyMatch[], signal: AbortSignal) {
    const domain = matches.find((match) => match.domain)?.domain;
    const owner = domain ? await this.deps.companies.resolveDomain(domain, signal) : null;
    const id = owner?.status === "matched" ? owner.companyId : null;
    const answer = owner ? `${owner.status}: ${owner.reason}` : "no domain";
    return { id, why: `domain ${domain ?? "-"} resolves to no company (${answer})` };
  }

  private async productOwner(matches: NamedBrandCompanyMatch[], signal: AbortSignal) {
    const products = this.deps.products;
    if (!products) {
      return { id: null, why: "no product reader" };
    }
    const ids: string[] = [];
    for (const { brandId } of matches) {
      ids.push(...(await this.deps.brands.deliveredProducts(brandId, PRODUCT_SAMPLE)));
    }
    const owners = new Set<string | null>();
    for (const id of ids.slice(0, PRODUCT_SAMPLE)) {
      owners.add(await products.companyOf(id, signal));
    }
    const [only] = owners;
    const id = owners.size === 1 && only ? only : null;
    const held = [...owners].map((owner) => owner ?? "none").join(", ") || "none";
    return { id, why: `${ids.length} sent products belong to ${held}` };
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
