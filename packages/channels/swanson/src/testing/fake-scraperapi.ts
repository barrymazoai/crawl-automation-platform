import { ScraperApiPages, type ScraperApiCaptureSettings } from "@crawl-automation/channels-core";
import {
  scraperApiErrors,
  type ScraperApiPage,
  type ScraperApiRequest,
} from "@crawl-automation/platform";
import { vi } from "vitest";

const settings: ScraperApiCaptureSettings = {
  routeId: "route-test",
  egressId: "scraperapi-us/1",
  defaults: { countryCode: "us", sessionNumber: null, render: false, premium: false },
  channels: {},
};

/**
 * ScraperAPI pages answered by a fake client: the page body; a 404/410 page (a gone listing); or the provider's
 * refusal for any other status that is not 200 (through ScraperAPI a refused page arrives as a provider failure).
 * `finalUrl` is where a same-site redirect landed. `fetches` counts paid requests.
 */
export function fakeScraperApiPages(body: Buffer, status = 200, finalUrl?: string) {
  const fetches = vi.fn(async (request: ScraperApiRequest): Promise<ScraperApiPage> => {
    if (status !== 200 && status !== 404 && status !== 410) {
      throw scraperApiErrors.create("SCRAPERAPI.PROVIDER_FAILURE");
    }
    return {
      status,
      url: finalUrl ?? request.target,
      contentType: "text/html; charset=utf-8",
      contentEncoding: null,
      bytes: body,
      creditCost: 1,
    };
  });
  const client = { provider: "scraperapi-sync/1" as const, get: fetches };
  return { fetches, pages: new ScraperApiPages(client, settings) };
}
