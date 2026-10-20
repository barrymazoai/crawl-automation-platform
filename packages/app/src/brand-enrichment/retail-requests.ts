import { retailSiteOf, type BrandRequest } from "@crawl-automation/v3-contracts";
import type { BrandRequests } from "./ports.js";

/**
 * Owner 2026-10-20 (KAN-220): retailers and marketplaces (GNC, Amazon, …) are not enriched. The request fails at once
 * with the reason, without a run; the admins get Supply Smart's failure notice. Returns the site, if any.
 */
export async function refuseRetailSite(
  requests: Pick<BrandRequests, "update">,
  request: BrandRequest,
  signal: AbortSignal,
) {
  const site = retailSiteOf(request.brandUrl);
  if (site) {
    await requests.update(
      {
        id: request.id,
        status: "failed",
        reason: `Not enriched: ${site} is a retailer / marketplace site. Retailers are not enriched; request the brands it sells by their own websites.`,
      },
      signal,
    );
  }
  return site;
}
