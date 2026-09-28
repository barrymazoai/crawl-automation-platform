import type { CatalogScope } from "@crawl-automation/v3-contracts";

export declare const historyListingId: (asin: string) => string;
export declare const candidateId: (campaign: string, asin: string) => string;
export interface LinkBatch {
  codec: "amazon-link-batch/1"; requestId: string; scope: CatalogScope; candidateManifestSha256: string;
  entries: { entry: { url: string; kind: "product"; listingId: string; variantId: null }; candidateId: string; historyListingId: string }[];
}
export declare function linkBatches(campaign: string, candidates: readonly { asin: string; scope: CatalogScope }[],
  candidateManifestSha256: string, newId?: () => string): LinkBatch[];
