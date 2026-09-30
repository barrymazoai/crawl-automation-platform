import type { ScraperApiClient } from "@crawl-automation/platform";

type PageClient = Pick<ScraperApiClient, "get" | "provider">;

/** Evidence uses the single-submission path, including its refusal of redirects without a second paid call. */
export function singleRequestClient(
  client: Pick<ScraperApiClient, "getOnce" | "provider">,
): PageClient {
  return { provider: client.provider, get: client.getOnce.bind(client) };
}
