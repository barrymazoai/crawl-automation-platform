import type { BrandCompanyMatch, BrandCompanyStatus, SyncBrand } from "./brand-company-model.js";

export interface BrandCompanyRepository {
  upsert(result: BrandCompanyMatch): Promise<void>;
  /** Stored matches for these brands (unchecked brands are absent). */
  matches(brandIds: string[]): Promise<BrandCompanyMatch[]>;
  list(filter: { status?: BrandCompanyStatus; limit: number }): Promise<SyncBrand[]>;
  /** Filter before LIMIT, so recent or matched brands cannot starve the next eligible page. */
  candidates(filter: {
    limit: number;
    checkedBefore: string;
    recheckUnmatched: boolean;
  }): Promise<SyncBrand[]>;
}
