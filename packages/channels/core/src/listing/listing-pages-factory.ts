import {
  ScraperApiClient,
  type ObjectStore,
  type ScraperApiAccess,
} from "@crawl-automation/platform";
import type { ScraperApiRoute } from "@crawl-automation/v3-contracts";
import type { ChannelId } from "../adapter.js";
import type { ListingChannelSettings } from "./listing-fetch-settings.js";
import { ListingPages } from "./listing-pages.js";

/** API and worker listing readers share the same provider options and archive contract. */
export function createListingPages(
  settings: {
    route: ScraperApiRoute;
    scraperApi: ScraperApiAccess;
    channels: Partial<Record<ChannelId, ListingChannelSettings>>;
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
      channels: Object.fromEntries(
        Object.entries(channels).map(([channel, { requestIntervalMs: _interval, ...options }]) => [
          channel,
          options,
        ]),
      ),
    },
    remote,
  });
}
