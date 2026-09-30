import { ChannelProductEvidenceSchema, type Observation } from "@crawl-automation/v3-contracts";
import { ChannelError } from "./html-evidence.js";

/**
 * GNC's projection for the formula planner: the adapter's channel-independent product evidence, read from one
 * archived ScraperAPI page. Each size and flavour is its own 6-digit SKU listing with no variant.
 */
export function parseGncRenderedProduct(raw: unknown, expectedUrl: string, owner: Pick<Observation, "listingId" | "variantId">) {
  const product = ChannelProductEvidenceSchema.parse(raw);
  if (product.channel !== "gnc" || product.variantId !== null || owner.variantId !== null) throw new ChannelError("GNC.IDENTITY_CONFLICT");
  const expected = new URL(expectedUrl), actual = new URL(product.url);
  if (actual.hostname !== expected.hostname || product.listingId !== owner.listingId) throw new ChannelError("GNC.IDENTITY_CONFLICT");
  return product;
}
