import { appErrors } from "@crawl-automation/app";
import type { ScraperApiClient } from "@crawl-automation/platform";

type PageClient = Pick<ScraperApiClient, "get" | "provider">;

/**
 * The existing get() follows redirects with extra paid requests. Evidence requires getOnce(), which must refuse
 * redirects without following them. Until platform supplies that capability, refuse before any storage or fetch.
 */
export function singleRequestClient(client: PageClient): PageClient {
  if (!("getOnce" in client) || typeof client.getOnce !== "function") {
    throw appErrors.create("EVIDENCE.SINGLE_REQUEST_UNAVAILABLE");
  }
  const getOnce = client.getOnce as PageClient["get"];
  return { provider: client.provider, get: getOnce.bind(client) };
}
