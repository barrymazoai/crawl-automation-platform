import type { ListingPage } from "@crawl-automation/channels-core";
import type { BrowserPage, BrowserRead, ObjectStore } from "@crawl-automation/platform";
import { ListingArchive, type ArchivedListing } from "./whole-foods-listing-archive.js";
import { WholeFoodsBrandReader } from "./whole-foods-brand-reader.js";
import { WHOLE_FOODS_LIST_SCROLL, WHOLE_FOODS_PAGE_POLICY } from "./whole-foods-policy.js";
import { parseWholeFoodsListing } from "./whole-foods-listing.js";
import { wholeFoodsErrors } from "./whole-foods-errors.js";
import {
  WHOLE_FOODS_SCAN_DEFAULTS,
  type WholeFoodsScanSettings,
} from "./whole-foods-scan-settings.js";
import type { WholeFoodsStore } from "./whole-foods-store.js";

/** Each read closes its task-owned page before returning. */
export interface ScanBrowser {
  readonly provider: string;
  read(request: BrowserRead, signal: AbortSignal): Promise<BrowserPage>;
}

export interface WholeFoodsBrandScanDeps {
  browser: ScanBrowser;
  remote: ObjectStore;
  store: WholeFoodsStore;
  settings?: WholeFoodsScanSettings;
}

export interface BrowserBrandScan {
  sourceUrl: string;
  pages: ListingPage[];
  /** Only a clean, stable page end proves completeness; the heading total is informational. */
  complete: boolean;
  /** False only after a healthy canary verifies a no-results brand search. */
  soldHere: boolean;
  archiveKeys: string[];
  cooldownRequested?: boolean;
}

/** Draw, archive byte-exact evidence, then parse. A broken list keeps every observed product. */
export class WholeFoodsBrandScan extends WholeFoodsBrandReader {
  private readonly settings: WholeFoodsScanSettings;

  constructor(private readonly deps: WholeFoodsBrandScanDeps) {
    super(deps.store);
    this.settings = deps.settings ?? WHOLE_FOODS_SCAN_DEFAULTS;
  }

  async scan(
    request: { scanId: string; sourceUrl: string },
    signal: AbortSignal,
  ): Promise<BrowserBrandScan> {
    const url = this.sourceUrl(request.sourceUrl);
    const saved = await this.read({ scanId: request.scanId, label: "search", url }, signal);
    const listing = parseWholeFoodsListing(
      saved.html,
      this.deps.store,
      saved.record.scroll.observedItems,
    );
    const archiveKeys = [saved.key];
    if (!listing.soldHere) {
      archiveKeys.push(await this.checkCanary(request.scanId, signal));
      if (!clean(saved)) {
        throw this.throttled(archiveKeys);
      }
    }
    return {
      sourceUrl: url,
      pages: [{ ...listing.page, soldHere: listing.soldHere }],
      complete: clean(saved) && saved.record.scroll.ended === "stable",
      soldHere: listing.soldHere,
      archiveKeys,
      ...(saved.record.scroll.ended === "broken" ? { cooldownRequested: true } : {}),
    };
  }

  private async checkCanary(scanId: string, signal: AbortSignal): Promise<string> {
    const saved = await this.read(
      { scanId, label: "canary", url: this.settings.canaryUrl },
      signal,
    );
    const archiveKeys = [`v3/brand-scans/${scanId}/search.html`, saved.key];
    if (!clean(saved)) {
      throw this.throttled(archiveKeys);
    }
    try {
      if (parseWholeFoodsListing(saved.html, this.deps.store).soldHere) {
        return saved.key;
      }
    } catch (error) {
      if (!wholeFoodsErrors.is(error, "WHOLEFOODS.LISTING_UNVERIFIED")) {
        throw error;
      }
      throw this.throttled(archiveKeys, error);
    }
    throw this.throttled(archiveKeys);
  }

  private throttled(archiveKeys: string[], cause?: unknown) {
    return wholeFoodsErrors.create("WHOLEFOODS.SEARCH_THROTTLED", {
      cause,
      details: { cooldownRequested: true, archiveKeys },
    });
  }

  private async read(place: { scanId: string; label: string; url: string }, signal: AbortSignal) {
    const archive = new ListingArchive(this.deps.remote, {
      ...place,
      maxBytes: WHOLE_FOODS_PAGE_POLICY.maxBytes,
    });
    const saved = await archive.inspect(signal);
    if (saved) {
      return saved;
    }
    const { browser, store } = this.deps;
    const page = await browser.read(
      {
        url: place.url,
        readySelector: "main",
        timeoutMs: WHOLE_FOODS_PAGE_POLICY.timeoutMs,
        scroll: {
          ...WHOLE_FOODS_LIST_SCROLL,
          pressDelayMs: this.settings.pressDelayMs,
          // A canary needs only the initial results, never another catalog's Load More requests.
          ...(place.label === "canary"
            ? { moreTexts: [], maxRounds: WHOLE_FOODS_LIST_SCROLL.stableRounds }
            : {}),
        },
      },
      signal,
    );
    return archive.save(
      { page, url: place.url, provider: browser.provider, storeId: store.storeId },
      signal,
    );
  }
}

function clean(saved: ArchivedListing): boolean {
  return (
    saved.record.ready !== false &&
    (saved.record.status == null || saved.record.status < 400) &&
    !saved.record.readinessFailure &&
    saved.record.scroll.ended !== "broken"
  );
}
