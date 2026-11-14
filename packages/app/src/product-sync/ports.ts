import type {
  BrandCompanyMatch,
  BrandCompanyStatus,
  NamedBrandCompanyMatch,
  SyncBrand,
} from "./brand-company-model.js";

export interface BrandCompanyRepository {
  upsert(result: BrandCompanyMatch): Promise<void>;
  /** After an owner-approved merge: brands matched to the merged company are matched to the survivor. */
  moveCompany(fromCompanyId: string, toCompanyId: string): Promise<number>;
  /** Stored matches for these brands (unchecked brands are absent). */
  matches(brandIds: string[]): Promise<BrandCompanyMatch[]>;
  list(filter: { status?: BrandCompanyStatus; limit: number }): Promise<SyncBrand[]>;
  /** Filter before LIMIT, so recent or matched brands cannot starve the next eligible page. */
  candidates(filter: {
    limit: number;
    checkedBefore: string;
    recheckUnmatched: boolean;
  }): Promise<SyncBrand[]>;
  /** Matched brands checked at or before `checkedBefore`, least recently checked first. */
  staleMatches(filter: { limit: number; checkedBefore: string }): Promise<NamedBrandCompanyMatch[]>;
  /** Supply Smart product IDs the sync recorded for this brand's products (any channel), at most `limit`. */
  deliveredProducts(brandId: string, limit: number): Promise<string[]>;
}

/** The company a Supply Smart product belongs to now (a merge moves products to the survivor). */
export interface ProductCompanies {
  companyOf(productId: string, signal: AbortSignal): Promise<string | null>;
}
