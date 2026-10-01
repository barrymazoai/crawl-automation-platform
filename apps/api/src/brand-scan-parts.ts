import { dtcBrandSourceUrl, type DtcSitePolicy } from "@crawl-automation/channel-dtc";
import { channelRegistry } from "./resources/channel-registry.js";
import {
  PostgresBrandScans,
  PostgresBrandSourceImport,
  TemporalBrowserScans,
  TemporalBrandListings,
} from "@crawl-automation/adapters";
import {
  BrandScanRunner,
  BrandScanService,
  AmazonBrandScanQueue,
  BrandSourceImport,
  type BrowserBrandScanners,
  type BrowserBrandScanner,
  type ListingStateService,
  type QueueService,
} from "@crawl-automation/app";
import { wholeFoodsSourceFromAmazon } from "./whole-foods-source-derivation.js";
import { adapterBrowserScanners } from "./browser-scan-gateways.js";
import { createListingPages } from "@crawl-automation/channels-core";
import { type TemporalClient, type Database, type Logger } from "@crawl-automation/platform";
import { createR2Objects } from "@crawl-automation/platform";
import type { BrandScanSettings } from "./brand-scan-config.js";

/** Browser sources run in Ego on the browser worker; HTTP sources never call these gateways. */
export function browserScanners(
  settings: BrandScanSettings,
  temporal: TemporalClient,
  dtcSites: readonly DtcSitePolicy[],
): BrowserBrandScanners & { dtc?: BrowserBrandScanner } {
  if (!settings.browserQueue) {
    return {};
  }
  const scans = new TemporalBrowserScans(temporal.client, settings.browserQueue, settings.permits);
  return {
    dtc: {
      sourceUrl: (url) => dtcBrandSourceUrl(url, dtcSites),
      scan: (request, signal) => scans.scan({ channel: "dtc", ...request }, signal),
    },
    ...adapterBrowserScanners(channelRegistry(dtcSites), scans),
  };
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
  dtcSites?: readonly DtcSitePolicy[];
  temporal: TemporalClient;
  log: Logger;
}): BrandScanParts {
  const { database, settings, log } = parts;
  const dtcSites = parts.dtcSites ?? [];
  const registry = channelRegistry(dtcSites, settings?.swanson);
  const store = new PostgresBrandScans(database);
  const remote = settings ? createR2Objects(settings.r2, settings.r2Credentials).store : null;
  const browsers = settings ? browserScanners(settings, parts.temporal, dtcSites) : {};
  const brandSources = sourceImports({ database, registry, browsers, log, store });
  const brandScans = new BrandScanService({ store, registry, browsers, log, enabled: !!settings });
  if (!settings || !remote) {
    return { brandScans, brandSources, runner: null };
  }
  const readers = { registry, pages: createListingPages(settings, remote), browsers };
  const amazonQueue = new AmazonBrandScanQueue({
    queue: parts.queue,
    knownListings: (scan) => store.knownListings(scan.source, scan.scanId),
  });
  const deps = {
    ...readers,
    channels: settings.channels,
    store,
    queue: parts.queue,
    listings: parts.listingStates,
    log,
    amazonQueue,
    gatedListings: gatedListings(settings, parts.temporal),
  };
  return { brandScans, brandSources, runner: new BrandScanRunner(deps, settings.runner) };
}

function gatedListings(settings: BrandScanSettings, temporal: TemporalClient) {
  return Object.fromEntries(
    Object.entries(settings.permits)
      .filter(([channel]) => channel !== "wholefoods")
      .map(([channel, permit]) => [channel, new TemporalBrandListings(temporal.client, permit)]),
  );
}

function sourceImports(parts: {
  database: Database;
  registry: ReturnType<typeof channelRegistry>;
  browsers: BrowserBrandScanners;
  log: Logger;
  store: PostgresBrandScans;
}) {
  const { database, registry, browsers, log, store } = parts;
  const sourceStore = new PostgresBrandSourceImport(database);
  return new BrandSourceImport({
    store: sourceStore,
    derived: {
      sources: store,
      store: sourceStore,
      channel: "wholefoods",
      derive: wholeFoodsSourceFromAmazon,
    },
    registry,
    browsers,
    log,
  });
}
