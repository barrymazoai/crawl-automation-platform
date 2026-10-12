import type { ChannelRegistry } from "@crawl-automation/channels-core";
import type {
  ChannelProductEvidence,
  LabelCollectedProduct,
  SharedEnrichmentRecord,
} from "@crawl-automation/v3-contracts";
import type { DeliveryHistory } from "../product-delivery/ports.js";
import type { MarketplaceChannel } from "./ledger.js";
export type { MarketplaceChannel } from "./ledger.js";

export const MARKETPLACE_CHANNELS = ["amazon", "gnc", "swanson", "wholefoods", "costco"] as const;
/** Inject the existing channel registry; only its pure retained-page parsers are used. */
export type MarketplaceChannels = Pick<ChannelRegistry, "get">;
export interface MarketplaceHistory extends DeliveryHistory {
  codec: "v3-capture-history/1";
  observationId: string;
  owner: DeliveryHistory["owner"] & { operationId: string; brandId: string };
}
export interface MarketplaceProduct {
  channel: MarketplaceChannel;
  listingId: string;
  variantId: string | null;
  url: string;
  runId: string;
  sourceId: string;
  brand: string;
  brandId?: string;
  queueId?: string;
  /**
   * When this product's material last settled (the sweep's watermark), as PostgreSQL timestamptz text with its full
   * microsecond precision; it is written back unchanged, never through a JavaScript Date.
   */
  materialAt?: string;
  history: MarketplaceHistory | null;
  product: ChannelProductEvidence | null;
  collection: LabelCollectedProduct | null;
  enrichment: SharedEnrichmentRecord | null;
  /** Whole Foods only: verified Amazon capture provenance for the collection of the same ASIN. */
  labelHistory?: MarketplaceHistory | null;
  /** Retained, selected-product structured identifiers/options, when available. */
  attributes?: Record<string, unknown>;
  problem?: string;
}
export interface MarketplaceMappingOptions {
  /** The matched BRAND company's domain, never derived from a retailer URL. */
  domain: string;
  /** Supply Smart batch ID, independent of product.runId. Labels intentionally stay run-independent. */
  runId: string;
  companyId?: string;
}
export interface MarketplaceCursor {
  listingId: string;
  variantId: string | null;
}
export interface MarketplaceReadRequest {
  channel: MarketplaceChannel;
  limit: number;
  after?: MarketplaceCursor;
  /** Only matched brands' products that are new or settled again since their last send (the automatic sweep). */
  pending?: boolean;
}
export interface MarketplacePage {
  products: MarketplaceProduct[];
  /** Last scanned identity, including material failures; do not get stuck retrying a bad row. */
  after: MarketplaceCursor | null;
}
