import { CancelScansSchema, type CancelScanCounts } from "./scan-cancellation.js";
import type { ChannelRegistry } from "@crawl-automation/channels-core";
import type { BrowserBrandScanners } from "./ports.js";
import { sourceUrlOf } from "./scan-listing.js";
import type { Logger } from "@crawl-automation/platform";
import { appErrors } from "../errors.js";
import type { BrandScanStore } from "./ports.js";
import {
  RequestScansSchema,
  ScanListQuerySchema,
  type ScanChannel,
  type ScanDetail,
  type ScanRecord,
  type ScanSource,
} from "./scan-model.js";

/**
 * Brand scans on request: every product a brand lists goes into the shared queue. Only enabled sources of a channel
 * that has a brand-scan reader are scanned; the runner does the reading.
 */
export class BrandScanService {
  constructor(
    private readonly deps: {
      store: BrandScanStore;
      registry: ChannelRegistry;
      browsers: BrowserBrandScanners;
      log: Logger;
      /** False when this process has no scan settings (R2 and ScraperAPI): requests are refused, never parked. */
      enabled: boolean;
    },
  ) {}

  async request(raw: unknown): Promise<ScanRecord[]> {
    const request = RequestScansSchema.parse(raw);
    if (!this.deps.enabled) {
      throw appErrors.create("BRAND_SCAN.NOT_CONFIGURED");
    }
    const sources = request.sourceIds
      ? await this.namedSources(request.sourceIds)
      : await this.deps.store.enabledSources(request.channel as ScanChannel);
    const scannable = sources.map((source) => this.scannable(source));
    if (scannable.length === 0) {
      throw appErrors.create("BRAND_SCAN.NO_SOURCES", { details: { channel: request.channel } });
    }
    const scans = await this.deps.store.request(request.requestId, scannable);
    this.deps.log.info(
      { requestId: request.requestId, scans: scans.length },
      "brand scans requested",
    );
    return scans;
  }

  cancel(raw: unknown): Promise<CancelScanCounts> {
    return this.deps.store.cancel(CancelScansSchema.parse(raw));
  }

  list(raw: unknown): Promise<ScanRecord[]> {
    return this.deps.store.list(ScanListQuerySchema.parse(raw ?? {}));
  }

  /** One scan, with what its revisits have shown so far. */
  async get(scanId: string): Promise<ScanDetail> {
    const scan = await this.deps.store.get(scanId);
    if (!scan) {
      throw appErrors.create("SCAN.NOT_FOUND", { details: { scanId } });
    }
    return { ...scan, revisits: await this.deps.store.revisits(scan.revisitBatchId) };
  }

  private async namedSources(sourceIds: readonly string[]): Promise<ScanSource[]> {
    const sources = await this.deps.store.sources(sourceIds);
    const found = new Set(sources.map((source) => source.sourceId));
    const unknown = sourceIds.filter((sourceId) => !found.has(sourceId));
    if (unknown.length > 0) {
      throw appErrors.create("BRAND.SOURCE_NOT_FOUND", { details: { sourceIds: unknown } });
    }
    return sources;
  }

  /** An enabled source of a channel with a brand-scan reader, its URL in the reader's own form. */
  private scannable(source: ScanSource): ScanSource {
    if (!source.enabled) {
      throw appErrors.create("BRAND_SCAN.SOURCE_DISABLED", {
        details: { sourceId: source.sourceId },
      });
    }
    const normalise = sourceUrlOf(this.deps, source.channel as ScanChannel);
    return { ...source, url: normalise(source.url) };
  }
}
