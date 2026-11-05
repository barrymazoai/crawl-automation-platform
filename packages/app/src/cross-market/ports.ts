import type {
  AmazonChannel,
  CrossMarketField,
  CrossMarketListing,
  CrossMarketVerdict,
} from "@crawl-automation/v3-contracts";
import type { MarketplaceProduct } from "../product-sync/marketplace-model.js";

/** The listings Supply Smart (the storefront's own target) holds for these external IDs, per ID. */
export interface CrossMarketListings {
  lookup(externalIds: string[], signal: AbortSignal): Promise<Map<string, CrossMarketListing[]>>;
}

/** The crawler's own settled products of a storefront for these listings (with their collected labels). */
export interface CrossMarketMaterial {
  read(
    channel: AmazonChannel,
    listingIds: string[],
    signal: AbortSignal,
  ): Promise<MarketplaceProduct[]>;
}

/** One side of the comparison, as its label and page print it. */
export interface CrossMarketSide {
  marketplace: string;
  title: string | null;
  brand: string | null;
  servingSize: string | null;
  servingsPerContainer: string | null;
  rows: { name: string; amount: string | null; dailyValue: string | null }[];
  otherIngredients: string | null;
}

export interface CrossMarketJudgment {
  verdict: CrossMarketVerdict;
  reasons: string[];
  model: string;
}

/** The model's judgment of two storefronts' listings of one ASIN. */
export interface CrossMarketJudge {
  judge(
    input: { listing: CrossMarketSide; other: CrossMarketSide },
    signal: AbortSignal,
  ): Promise<CrossMarketJudgment>;
}

/** Which listing a check is about: this capture's label against one other listing in Supply Smart. */
export interface CrossMarketKey {
  channel: AmazonChannel;
  listingId: string;
  collectionOperationId: string;
  comparedListingId: string;
}

export type CrossMarketRecord = CrossMarketKey &
  (
    | { status: "pending"; recordedAt: string }
    | { status: "decided"; field: CrossMarketField; recordedAt: string }
    /** No judgment was possible; the listing is sent without a verdict (Supply Smart's default), and why is kept. */
    | { status: "unjudged"; reason: string; recordedAt: string }
  );

/** Append-only: every check outcome is kept; the newest per key is the one in force. */
export interface CrossMarketRecords {
  latest(key: CrossMarketKey): Promise<CrossMarketRecord | null>;
  record(record: CrossMarketRecord): Promise<void>;
}

/** Queues the other storefront's product page once, so the comparison has material (owner 2026-11-05). */
export interface CrossMarketRecapture {
  request(
    input: { channel: AmazonChannel; listingId: string; brandId: string },
    signal: AbortSignal,
  ): Promise<"queued" | "already-queued" | "no-source">;
}
