import {
  ScraperApiClient,
  type ObjectStore,
  type ScraperApiAccess,
} from "@crawl-automation/platform";
import type { ScraperApiRoute } from "@crawl-automation/v3-contracts";
import type { ScraperApiCaptureSettings } from "../capture/page-fetch.js";
import { ListingPages } from "./listing-pages.js";

/** API and worker listing readers share the same provider options and archive contract. */
export function createListingPages(
  settings: {
    route: ScraperApiRoute;
    scraperApi: ScraperApiAccess;
    channels: ScraperApiCaptureSettings["channels"];
  },
  remote: ObjectStore,
): ListingPages {
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
