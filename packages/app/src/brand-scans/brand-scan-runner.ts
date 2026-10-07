import { compareScanListings } from "./scan-comparison.js";
import {
  cancelledScanResult,
  checkScanCancellation,
  emptyScanResult,
} from "./scan-cancellation.js";
import { listingScanResult } from "./listing-scan-result.js";
import { scanQueueMetrics } from "./scan-queue-metrics.js";
import { setTimeout as delay } from "node:timers/promises";
import { pipelineErrors, errorCodeOf, type Logger } from "@crawl-automation/platform";
import { z } from "zod";
import type { ListingStateService } from "../listings/listing-state-service.js";
import type { QueueService } from "../queue/queue-service.js";
import type { QueuedProduct, QueueAddResult } from "../queue/queue-model.js";
import type { BrandScanStore } from "./ports.js";
import { hasScanTotalProof } from "./scan-completeness.js";
import { readListing, type BrandListing } from "./scan-listing.js";
import type { ScanReaders } from "./scan-listing.js";
import type { ScanChannel, ScanRecord, ScanResult } from "./scan-model.js";
import type { AmazonScanQueue } from "./amazon-scan-queue.js";
import { appErrors } from "../errors.js";
import type { GatedBrandListing } from "./scan-permits.js";

export const BrandScanRunnerSettingsSchema = z.strictObject({
  intervalMs: z.number().int().min(500).max(60_000).default(5_000),
  /** Brands scanned at once; each scan reads its pages one after another. */
  concurrent: z.number().int().min(1).max(32).default(4),
  /** A running scan untouched this long is taken over (its pages are archived; nothing is paid twice). */
  staleMs: z.number().int().min(60_000).max(86_400_000).default(1_800_000),
});
export type BrandScanRunnerSettings = z.infer<typeof BrandScanRunnerSettingsSchema>;

export interface BrandScanRunnerDeps extends ScanReaders {
  gatedListings?: Partial<Record<ScanChannel, GatedBrandListing>>;
  amazonQueue?: AmazonScanQueue;
  store: BrandScanStore;
  /** Discovery-only port: the composition root binds add to QueueService.addScanDiscovery. */
  queue: Pick<QueueService, "add">;
  listings: Pick<ListingStateService, "requestRevisits">;
  log: Logger;
}

const toQueued =
  (scan: ScanRecord) =>
  (product: BrandListing["products"][number]): QueuedProduct => ({
    sourceId: scan.source.sourceId,
    url: product.url,
    listingId: product.listingId,
    variantId: product.variantId,
  });

/**
 * Runs requested brand scans: reads each source with its declared capture, admits discoveries through the
 * queue's SKU window, and after a full scan queues a direct revisit of every known listing
 * the brand no longer lists. Absence alone is never recorded as a sighting.
 */
export class BrandScanRunner {
  private readonly settings: BrandScanRunnerSettings;

  constructor(
    private readonly deps: BrandScanRunnerDeps,
    settings: Partial<BrandScanRunnerSettings> = {},
  ) {
    this.settings = BrandScanRunnerSettingsSchema.parse(settings);
  }

  /** Scans this runner is working on; their slots are not offered again and their rows are never re-claimed. */
  private readonly active = new Map<string, Promise<void>>();

  /**
   * Keeps every slot busy (owner 2026-10-07, CRAWLV3-213): a finished scan's slot is refilled on the next round,
   * so one slow browser channel never holds the runner and a priority change takes effect within a round.
   */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        this.start(await this.claimFree(), signal);
      } catch (error) {
        // One failed round never stops scanning; the next round starts from the table again.
        this.deps.log.error({ err: error, code: errorCodeOf(error) }, "brand scan round failed");
      }
      await delay(this.settings.intervalMs, undefined, { signal }).catch(() => undefined);
    }
    await Promise.allSettled(this.active.values());
  }

  /** One round that waits for the scans it started. */
  async tick(signal: AbortSignal): Promise<void> {
    await Promise.all(this.start(await this.claimFree(), signal));
  }

  private claimFree(): Promise<ScanRecord[]> {
    const free = this.settings.concurrent - this.active.size;
    return free > 0
      ? this.deps.store.claim(free, this.settings.staleMs, [...this.active.keys()])
      : Promise.resolve([]);
  }

  private start(scans: ScanRecord[], signal: AbortSignal): Promise<void>[] {
    return scans.map((scan) => {
      const running = this.scanOne(scan, signal).finally(() => this.active.delete(scan.scanId));
      this.active.set(scan.scanId, running);
      return running;
    });
  }

  /** One scan to its end: a result, or a Review-state record with the failure's own code. */
  private async scanOne(scan: ScanRecord, signal: AbortSignal): Promise<void> {
    const progress = emptyScanResult();
    let result: ScanResult;
    try {
      result = await this.scan(scan, signal, progress);
    } catch (error) {
      result = {
        ...progress,
        state: "review",
        code: errorCodeOf(error) ?? pipelineErrors.code("BRAND_SCAN.UNRESOLVED"),
      };
      this.deps.log.warn(
        { scanId: scan.scanId, err: error, code: result.code },
        "brand scan review",
      );
    }
    if (await this.deps.store.isCancellationRequested(scan.scanId)) {
      result = cancelledScanResult(result);
    }
    await this.deps.store.finish(scan.scanId, result);
    this.deps.log.info({ scanId: scan.scanId }, "brand scan finished");
  }

  private async scan(
    scan: ScanRecord,
    signal: AbortSignal,
    result: ScanResult,
  ): Promise<ScanResult> {
    const amazon = scan.source.channel === "amazon" ? this.amazonQueue() : null;
    const listing = await this.read(scan, signal);
    if (scan.source.channel === "wholefoods") {
      listing.full = hasScanTotalProof(listing);
    }
    Object.assign(result, listingScanResult(listing), {
      metrics: scanQueueMetrics({ added: 0 }, listing.metrics),
    });
    // Known: queued by an earlier list of this source (the scan's own list is excluded).
    const known = amazon
      ? await amazon.knownListings(scan)
      : await this.deps.store.knownListings(scan.source, scan.scanId);
    if (await this.deps.store.isCancellationRequested(scan.scanId)) {
      return cancelledScanResult(result);
    }
    const admission = await this.queueAll(scan, listing);
    const counts = compareScanListings(listing, known);
    Object.assign(result, {
      newListings: counts.newListings,
      knownListings: counts.knownListings,
      queued: admission.added,
      metrics: scanQueueMetrics(admission, listing.metrics),
    });
    if (await this.deps.store.isCancellationRequested(scan.scanId)) {
      return cancelledScanResult(result);
    }
    const missing = listing.full ? await this.revisitMissing(scan, counts.missing) : 0;
    return {
      ...result,
      missing,
    };
  }

  private read(scan: ScanRecord, signal: AbortSignal): Promise<BrandListing> {
    const gated = this.deps.gatedListings?.[scan.source.channel as ScanChannel];
    return gated
      ? gated.read(scan, signal)
      : readListing(
          {
            ...this.deps,
            checkpoint: (scanId) => checkScanCancellation(this.deps.store, scanId),
          },
          scan,
          signal,
        );
  }

  /** The scan's ID makes replay return its admission receipt without inserting again. */
  private async queueAll(scan: ScanRecord, listing: BrandListing): Promise<QueueAddResult> {
    if (listing.products.length === 0) {
      return { added: 0 };
    }
    const channel = scan.source.channel as ScanChannel;
    if (channel === "amazon") {
      return this.amazonQueue().add(scan, listing.products, scan.scanId);
    }
    const products = listing.products.map(toQueued(scan));
    const label = `brand scan: ${scan.source.brandName}`.slice(0, 200);
    return this.deps.queue.add({ channel, batchId: scan.scanId, label, products });
  }

  /** Known listings a full scan no longer shows: each queued once for a direct revisit, which decides. */
  private async revisitMissing(scan: ScanRecord, missing: QueuedProduct[]): Promise<number> {
    if (missing.length === 0) {
      return 0;
    }
    if (scan.source.channel === "amazon") {
      await this.amazonQueue().add(scan, missing, scan.revisitBatchId);
      return missing.length;
    }
    await this.deps.listings.requestRevisits({
      channel: scan.source.channel,
      scope: "full",
      batchId: scan.revisitBatchId,
      label: `revisit after brand scan: ${scan.source.brandName}`.slice(0, 200),
      listings: missing,
    });
    return missing.length;
  }

  private amazonQueue(): AmazonScanQueue {
    if (!this.deps.amazonQueue) {
      throw appErrors.create("BRAND_SCAN.NOT_CONFIGURED", {
        details: { component: "amazonQueue" },
      });
    }
    return this.deps.amazonQueue;
  }
}
