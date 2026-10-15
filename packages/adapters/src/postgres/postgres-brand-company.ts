import {
  brandCompanyDomain,
  type BrandCompanyMatch,
  type BrandCompanyRepository,
  type MarketplaceBrands,
  type SyncBrand,
  type WaitingMarketplaceBrand,
} from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import {
  completedMarketplaceBrands,
  marketplaceBrandListings,
  upsertBrandCompany,
  waitingMarketplaceBrands,
} from "./brand-company-queries.js";

type BrandRow = Omit<SyncBrand, "match" | "dtcDomain"> &
  Omit<BrandCompanyMatch, "status" | "checkedAt"> & {
    dtcUrls: string[];
    status: BrandCompanyMatch["status"] | null;
    checkedAt: Date | null;
  };

function toBrand(row: BrandRow): SyncBrand {
  const domains = [...new Set(row.dtcUrls.map(brandCompanyDomain).filter(Boolean))];
  return {
    brandId: row.brandId,
    name: row.name,
    productCounts: row.productCounts,
    dtcDomain: domains.length === 1 ? (domains[0] ?? null) : null,
    match:
      row.status && row.checkedAt
        ? {
            brandId: row.brandId,
            status: row.status,
            companyId: row.companyId,
            domain: row.domain,
            matchedBy: row.matchedBy,
            candidates: row.candidates,
            checkedAt: row.checkedAt.toISOString(),
          }
        : null,
  };
}

/** Migration 060; collection settings (including disabled sources) do not hide completed products. */
export class PostgresBrandCompany implements BrandCompanyRepository {
  constructor(private readonly database: Queryable) {}

  async upsert(result: BrandCompanyMatch): Promise<void> {
    await this.database.query(upsertBrandCompany, [
      result.brandId,
      result.status,
      result.companyId,
      result.domain,
      result.matchedBy,
      JSON.stringify(result.candidates),
      result.checkedAt,
    ]);
  }

  async moveCompany(fromCompanyId: string, toCompanyId: string): Promise<number> {
    const rows = await this.database.query(
      `UPDATE supply_smart_brand_company SET company_id = $2::uuid, checked_at = clock_timestamp()
       WHERE company_id = $1::uuid RETURNING brand_id`,
      [fromCompanyId, toCompanyId],
    );
    return rows.length;
  }

  async matches(brandIds: string[]): Promise<BrandCompanyMatch[]> {
    if (!brandIds.length) {
      return [];
    }
    const rows = await this.database.query<{
      brand_id: string;
      status: BrandCompanyMatch["status"];
      company_id: string | null;
      domain: string | null;
      matched_by: string | null;
      candidates: string[];
      checked_at: Date;
    }>(
      `SELECT brand_id::text, status, company_id::text, domain, matched_by, candidates, checked_at
       FROM supply_smart_brand_company WHERE brand_id = ANY($1::uuid[])`,
      [brandIds],
    );
    return rows.map((row) => ({
      brandId: row.brand_id,
      status: row.status,
      companyId: row.company_id,
      domain: row.domain,
      matchedBy: row.matched_by,
      candidates: row.candidates,
      checkedAt: row.checked_at.toISOString(),
    }));
  }

  async list(filter: Parameters<BrandCompanyRepository["list"]>[0]): Promise<SyncBrand[]> {
    const rows = await this.database.query<BrandRow>(
      `${completedMarketplaceBrands}
       WHERE ($1::text IS NULL OR match.status = $1)
       ORDER BY brand.name, brand.id LIMIT $2`,
      [filter.status ?? null, filter.limit],
    );
    return rows.map(toBrand);
  }

  async candidates(
    filter: Parameters<BrandCompanyRepository["candidates"]>[0],
  ): Promise<SyncBrand[]> {
    const rows = await this.database.query<BrandRow>(
      `${completedMarketplaceBrands}
       WHERE match.brand_id IS NULL OR (match.status <> 'matched'
         AND ($2::boolean OR match.checked_at <= $1::timestamptz))
       ORDER BY match.checked_at ASC NULLS FIRST, brand.id LIMIT $3`,
      [filter.checkedBefore, filter.recheckUnmatched, filter.limit],
    );
    return rows.map(toBrand);
  }
}

/** Migration 063: our brands still waiting for a company, and hints for their website lookup. */
export class PostgresMarketplaceBrands implements MarketplaceBrands {
  constructor(private readonly database: Queryable) {}

  waiting(filter: { limit: number; brandIds?: string[] }): Promise<WaitingMarketplaceBrand[]> {
    return this.database.query<WaitingMarketplaceBrand>(waitingMarketplaceBrands, [
      filter.limit,
      filter.brandIds ?? null,
    ]);
  }

  listings(brandId: string, limit: number) {
    return this.database.query<{ channel: string; url: string }>(marketplaceBrandListings, [
      brandId,
      limit,
    ]);
  }
}
