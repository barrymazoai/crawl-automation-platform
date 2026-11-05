import type { AmazonChannel } from "@crawl-automation/v3-contracts";
import { listIdFrom } from "../queue/list-id.js";
import type { AddToQueue, QueueAddResult } from "../queue/queue-model.js";
import type { CrossMarketRecapture } from "./ports.js";

/** The shared queue: the brand's source on a storefront, and adding one product list. */
export interface CrossMarketQueue {
  sourceOf(channel: AmazonChannel, brandId: string): Promise<string | null>;
  add(list: AddToQueue): Promise<QueueAddResult>;
}

/**
 * The other storefront's product page, queued once per ASIN (a stable list ID; asking again adds nothing) under the
 * same crawler brand's source there. A brand with no source on that storefront cannot be compared.
 */
export class QueuedCrossMarketRecapture implements CrossMarketRecapture {
  constructor(
    private readonly deps: {
      queue: CrossMarketQueue;
      productUrl(channel: AmazonChannel, listingId: string): string;
    },
  ) {}

  async request(input: { channel: AmazonChannel; listingId: string; brandId: string }) {
    const sourceId = await this.deps.queue.sourceOf(input.channel, input.brandId);
    if (!sourceId) {
      return "no-source" as const;
    }
    const url = this.deps.productUrl(input.channel, input.listingId);
    const { added } = await this.deps.queue.add({
      channel: input.channel,
      batchId: listIdFrom(`cross-market-material:${input.channel}:${input.listingId}`),
      label: "cross-market check: the same ASIN on another storefront",
      products: [{ sourceId, url, listingId: input.listingId, variantId: null }],
    });
    return added ? ("queued" as const) : ("already-queued" as const);
  }
}
