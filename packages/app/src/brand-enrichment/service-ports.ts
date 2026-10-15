import type { BrandEnrichmentRun, BrandProductsRetryRequest } from "@crawl-automation/v3-contracts";
import type { BrandCompanyRepository } from "../product-sync/ports.js";
import type {
  BrandRequests,
  BrandEnrichmentRuns,
  BrandEnrichmentReviews,
  MarketplaceBrands,
  SupplySmartCompanies,
} from "./ports.js";
import type { BrandProductRedelivery } from "./product-redelivery.js";

/** Temporal adapter; the facade never knows Temporal clients or workflow options. */
export interface BrandEnrichmentGateway {
  startProductsRetry(input: BrandProductsRetryRequest): Promise<void>;
  describeProductsRetry(input: BrandProductsRetryRequest): Promise<{ status: string } | null>;
  start(runId: string): Promise<void>;
  /** A `marketplace` run: website lookup → identity → match for the product sync. */
  startMarketplace(runId: string): Promise<void>;
  cancel(runId: string): Promise<void>;
  describe(runId: string): Promise<{ status: string } | null>;
}
export type RunId = Pick<BrandEnrichmentRun, "runId">;

/** What the facade is built from; `redelivery`, `marketplace` and `matches` are optional per process. */
export type BrandEnrichmentFacadeDeps = {
  requests: BrandRequests;
  runs: BrandEnrichmentRuns;
  reviews: BrandEnrichmentReviews;
  companies: SupplySmartCompanies;
  gateway: BrandEnrichmentGateway;
  /** Absent when this process cannot reach the saved products (no storage configured). */
  redelivery?: BrandProductRedelivery;
  marketplace?: MarketplaceBrands;
  /** Our brand ↔ company matches: identity answers write them, merges repoint them (owner 2026-10-15). */
  matches?: Pick<BrandCompanyRepository, "upsert" | "moveCompany">;
};
