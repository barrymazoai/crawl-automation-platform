import type { Logger } from "@crawl-automation/platform";
import type { ListingStateDelivery } from "../listings/listing-delivery.js";
import type { MarketplaceChannel } from "./ledger.js";
import type { ProductSyncResult, ProductSyncService } from "./sync-service.js";

export interface ProductSyncSweepSettings {
  channels: MarketplaceChannel[];
  /** Products per ingest batch (≤200). */
  batchLimit: number;
  /** Batches per channel per sweep, so one sweep is bounded however large the backlog is. */
  maxBatchesPerChannel: number;
}

/**
 * One automatic round (owner 2026-10-12: completed marketplace products go to Supply Smart test automatically): for
 * each channel, send pending products (matched brand, new or settled again since their last send) in bounded batches,
 * then the delistings recorded since the last round. A channel's failure is logged and never stops the others.
 */
export class ProductSyncSweep {
  constructor(
    private readonly deps: {
      sync: Pick<ProductSyncService, "sync">;
      listings: Pick<ListingStateDelivery, "deliverPending">;
      settings: ProductSyncSweepSettings;
      log: Logger;
      now?: () => Date;
    },
  ) {}

  async sweep(signal: AbortSignal): Promise<ProductSyncResult[]> {
    const results: ProductSyncResult[] = [];
    for (const channel of this.deps.settings.channels) {
      signal.throwIfAborted();
      try {
        results.push(...(await this.channel(channel, signal)));
      } catch (error) {
        signal.throwIfAborted();
        this.deps.log.warn({ err: error, channel }, "product sync channel failed");
      }
    }
    await this.delistings(signal);
    return results;
  }

  private async delistings(signal: AbortSignal) {
    try {
      const startedAt = (this.deps.now?.() ?? new Date()).toISOString();
      const result = await this.deps.listings.deliverPending(startedAt, signal);
      this.deps.log.info(result, "listing states sent");
    } catch (error) {
      signal.throwIfAborted();
      this.deps.log.warn({ err: error }, "listing states failed");
    }
  }

  private async channel(channel: MarketplaceChannel, signal: AbortSignal) {
    const results: ProductSyncResult[] = [];
    for (let batch = 0; batch < this.deps.settings.maxBatchesPerChannel; batch += 1) {
      // `pending` pages always start at the beginning: sent products drop out of the selection.
      const result = await this.deps.sync.sync(
        { channel, limit: this.deps.settings.batchLimit, dryRun: false, pending: true },
        signal,
      );
      results.push(result);
      this.deps.log.info(
        {
          channel,
          read: result.read,
          sent: result.toSend,
          verified: result.verified,
          needsReview: result.needsReview,
          failed: result.failed.length,
          runId: result.ingestRunId,
        },
        "product sync batch",
      );
      // Stop when nothing new was sent: the rest of the page is material problems or waiting brands.
      if (result.read < this.deps.settings.batchLimit || result.toSend === 0) {
        break;
      }
    }
    return results;
  }
}
