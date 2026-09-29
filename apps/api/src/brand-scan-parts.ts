import { PostgresBrandScans, PostgresBrandSourceImport } from "@crawl-automation/adapters";
import {
  BrandScanRunner,
  BrandScanService,
  BrandSourceImport,
  type BrowserBrandScanners,
  type ListingStateService,
  type QueueService,
} from "@crawl-automation/app";
import { swansonAdapter } from "@crawl-automation/channel-swanson";
import { ChannelRegistry, ListingPages } from "@crawl-automation/channels-core";
import { gncAdapter } from "@crawl-automation/channels-gnc";
import {
  WholeFoodsBrandScan,
  wholeFoodsBrandSourceUrl,
} from "@crawl-automation/channels-wholefoods";
import {
  EgoPages,
  ScraperApiClient,
  type Database,
  type Logger,
  type ObjectStore,
} from "@crawl-automation/platform";
import { createR2Objects } from "@crawl-automation/v3-artifacts";
import type { BrandScanSettings } from "./brand-scan-config.js";

/** The channels brand scans read with their adapters' ScraperAPI readers. */
const scanRegistry = () => new ChannelRegistry([swansonAdapter, gncAdapter]);

/** Whole Foods in the Ego browser, when this machine has Ego and the store configured; otherwise not scanned here. */
function browserScanners(settings: BrandScanSettings, remote: ObjectStore): BrowserBrandScanners {
  const { ego, wholefoods } = settings;
  if (!ego || !wholefoods) {
    return {};
  }
  const scanner = new WholeFoodsBrandScan({
    browser: new EgoPages(ego),
    remote,
    store: wholefoods,
  });
  return {
    wholefoods: {
      sourceUrl: wholeFoodsBrandSourceUrl,
      scan: (request, signal) => scanner.scan(request, signal),
    },
  };
}

function listingPages(settings: BrandScanSettings, remote: ObjectStore): ListingPages {
  const { route, scraperApi, channels } = settings;
  return new ListingPages({
    client: new ScraperApiClient(scraperApi),
    settings: {
      routeId: route.routeId,
      egressId: route.egressId,
      defaults: {
        countryCode: route.countryCode,
        sessionNumber: route.sessionNumber,
        render: route.responseMode === "rendered-html",
        premium: false,
      },
      channels,
    },
    remote,
  });
}

export interface BrandScanParts {
  brandScans: BrandScanService;
  brandSources: BrandSourceImport;
  /** Null without scan settings: nothing is scanned by this process. */
  runner: BrandScanRunner | null;
}

/**
 * Brand scans and brand-source import. Scans run in the API process like the queue dispatcher; without their
 * settings, scan requests are refused (BRAND_SCAN.NOT_CONFIGURED) and no runner starts.
 */
export function brandScanParts(parts: {
  database: Database;
  queue: QueueService;
  listingStates: ListingStateService;
  settings: BrandScanSettings | undefined;
  log: Logger;
}): BrandScanParts {
  const { database, settings, log } = parts;
  const registry = scanRegistry();
  const store = new PostgresBrandScans(database);
  const remote = settings ? createR2Objects(settings.r2, settings.r2Credentials).store : null;
  const browsers = settings && remote ? browserScanners(settings, remote) : {};
  const brandSources = new BrandSourceImport({
    store: new PostgresBrandSourceImport(database),
    registry,
    browsers,
    log,
  });
  const brandScans = new BrandScanService({ store, registry, browsers, log, enabled: !!settings });
  if (!settings || !remote) {
    return { brandScans, brandSources, runner: null };
  }
  const readers = { registry, pages: listingPages(settings, remote), browsers };
  const deps = { ...readers, store, queue: parts.queue, listings: parts.listingStates, log };
  return { brandScans, brandSources, runner: new BrandScanRunner(deps, settings.runner) };
}
