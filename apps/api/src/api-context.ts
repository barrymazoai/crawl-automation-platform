import type { ApiParts } from "./container.js";
import type { ApiContext } from "./trpc.js";

/** Select services explicitly: spreading the awilix cradle would resolve every registration. */
export function apiContext(parts: ApiParts): ApiContext {
  return {
    usage: parts.usage,
    enrichment: parts.enrichment,
    evidence: parts.evidence,
    originals: parts.originals,
    runs: parts.runs,
    queue: parts.queue,
    brands: parts.brands,
    siteAnalyses: parts.siteAnalyses,
    reviews: parts.reviews,
    products: parts.products,
    history: parts.history,
    resources: parts.resources,
    fleet: parts.fleet,
    listingStates: parts.listingStates,
    brandScans: parts.brandScanParts.brandScans,
    brandSources: parts.brandScanParts.brandSources,
  };
}
