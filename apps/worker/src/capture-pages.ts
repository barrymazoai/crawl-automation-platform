import { ScraperApiPages } from "@crawl-automation/channels-core";
import { ScraperApiClient } from "@crawl-automation/platform";
import type { WorkerConfig } from "./config.js";

/** Product pages through ScraperAPI on the capture route, with each channel's options and challenge tier. */
export function capturePages(capture: NonNullable<WorkerConfig["capture"]>): ScraperApiPages {
  const { route, scraperApi, channels, challengeTiers } = capture;
  return new ScraperApiPages(new ScraperApiClient(scraperApi), {
    routeId: route.routeId,
    egressId: route.egressId,
    defaults: {
      countryCode: route.countryCode,
      sessionNumber: route.sessionNumber,
      render: route.responseMode === "rendered-html",
      premium: false,
    },
    channels,
    challengeTiers,
  });
}
