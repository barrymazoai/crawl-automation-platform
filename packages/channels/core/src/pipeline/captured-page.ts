import type {
  ChannelAdapter,
  ChannelId,
  CommerceEvidence,
  ParsedProduct,
  ProductAddress,
} from "../adapter.js";

/**
 * What one capture saw on the product page, for the metrics history: the listing, when it was captured, the
 * commerce the page showed (price, rating, reviews, stock) and the archived original it was read from.
 */
export interface CapturedPage {
  channel: ChannelId;
  url: string;
  listingId: string;
  variantId: string | null;
  /** The channel's product ID the history keys the listing by (ASIN, SKU…). */
  externalId: string;
  capturedAt: string;
  commerce: CommerceEvidence | null;
  archive: { objectKey: string; sha256: string };
}

/** The captured page of a parsed product, in the shape the metrics history records. */
export function capturedPage(
  adapter: ChannelAdapter,
  address: ProductAddress,
  captured: {
    parsed: ParsedProduct;
    archiveKey: string;
    archiveSha256: string;
    capturedAt: string;
  },
): CapturedPage {
  const { parsed } = captured;
  return {
    channel: adapter.id,
    url: address.url,
    listingId: address.listingId,
    variantId: address.variantId,
    externalId: adapter.externalId?.(parsed) ?? address.listingId,
    capturedAt: captured.capturedAt,
    commerce: parsed.commerce,
    archive: { objectKey: captured.archiveKey, sha256: captured.archiveSha256 },
  };
}
