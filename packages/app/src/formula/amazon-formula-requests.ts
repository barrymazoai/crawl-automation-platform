import { createHash } from "node:crypto";
import type { QueuedProduct } from "../queue/queue-model.js";

/** The shared queue's Amazon hold and the brand's Amazon source. */
export interface AmazonFormulaQueue {
  amazonSourceOf(brandId: string): Promise<string | null>;
  holdAmazonProducts(list: {
    batchId: string;
    label: string;
    products: QueuedProduct[];
  }): Promise<{ added: number }>;
}

export type AmazonFormulaRequest =
  | { status: "queued" | "already-queued"; listingId: string }
  | { status: "no-amazon-source"; listingId: string };

const LABEL = "ASIN seen on Whole Foods without an Amazon formula";

/** A stable list ID per ASIN (UUID-shaped), so asking again for the same ASIN adds nothing. */
function requestBatchId(asin: string): string {
  const hex = createHash("sha256").update(`amazon-formula-request:${asin}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * A product seen on a channel that shares Amazon's formulas (Whole Foods) whose ASIN has no Amazon formula yet:
 * its Amazon product page is queued once for Amazon, where the formula is extracted when Amazon's product runs
 * move onto the shared queue. The channel's own metrics are recorded meanwhile.
 */
export class AmazonFormulaRequests {
  constructor(
    private readonly deps: {
      queue: AmazonFormulaQueue;
      /** The Amazon product for an ASIN, as the channel's adapter names it. */
      amazonProduct(asin: string, sourceId: string): QueuedProduct;
    },
  ) {}

  async request(input: { brandId: string; asin: string }): Promise<AmazonFormulaRequest> {
    const listingId = input.asin.toUpperCase();
    const sourceId = await this.deps.queue.amazonSourceOf(input.brandId);
    if (!sourceId) {
      return { status: "no-amazon-source", listingId };
    }
    const product = this.deps.amazonProduct(listingId, sourceId);
    const list = { batchId: requestBatchId(listingId), label: LABEL, products: [product] };
    const { added } = await this.deps.queue.holdAmazonProducts(list);
    return { status: added ? "queued" : "already-queued", listingId };
  }
}
