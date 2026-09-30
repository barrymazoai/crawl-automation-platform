import {
  PostgresBrandScans,
  PostgresBrandSourceImport,
  TemporalBrowserScans,
} from "@crawl-automation/adapters";
import {
  BrandScanRunner,
  BrandScanService,
  AmazonBrandScanQueue,
  BrandSourceImport,
  type BrowserBrandScanners,
  type ListingStateService,
  type QueueService,
} from "@crawl-automation/app";
import { swansonAdapter } from "@crawl-automation/channel-swanson";
import { amazonAdapter, amazonStoreSourceUrl } from "@crawl-automation/channel-amazon";
import { ChannelRegistry, ListingPages } from "@crawl-automation/channels-core";
import { gncAdapter } from "@crawl-automation/channels-gnc";
import { wholeFoodsBrandSourceUrl } from "@crawl-automation/channels-wholefoods";
import {
  ScraperApiClient,
  type TemporalClient,
  type Database,
  type Logger,
  type ObjectStore,
} from "@crawl-automation/platform";
import { createR2Objects } from "@crawl-automation/platform";
import type { BrandScanSettings } from "./brand-scan-config.js";

/** The channels brand scans read with their adapters' ScraperAPI readers. */
const scanRegistry = () => new ChannelRegistry([swansonAdapter, gncAdapter, amazonAdapter]);

/** Browser sources run in Ego on the browser worker; HTTP sources never call these gateways. */
function browserScanners(
  settings: BrandScanSettings,
  temporal: TemporalClient,
): BrowserBrandScanners {
  if (!settings.browserQueue) {
    return {};
  }
  const scans = new TemporalBrowserScans(temporal.client, settings.browserQueue);
  return {
    amazon: {
      sourceUrl: amazonStoreSourceUrl,
      scan: (request, signal) => scans.scan({ channel: "amazon", ...request }, signal),
    },
    wholefoods: {
      sourceUrl: wholeFoodsBrandSourceUrl,
      scan: (request, signal) => scans.scan({ channel: "wholefoods", ...request }, signal),
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
  temporal: TemporalClient;
  log: Logger;
}): BrandScanParts {
  const { database, settings, log } = parts;
  const registry = scanRegistry();
  const store = new PostgresBrandScans(database);
  const remote = settings ? createR2Objects(settings.r2, settings.r2Credentials).store : null;
  const browsers = settings ? browserScanners(settings, parts.temporal) : {};
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
  const amazonQueue = new AmazonBrandScanQueue({
    queue: parts.queue,
    knownListings: (scan) => store.knownListings(scan.source, scan.scanId),
  });
  const deps = {
    ...readers,
    store,
    queue: parts.queue,
    listings: parts.listingStates,
    log,
    amazonQueue,
  };
  return { brandScans, brandSources, runner: new BrandScanRunner(deps, settings.runner) };
}
