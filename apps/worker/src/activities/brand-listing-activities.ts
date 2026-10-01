import { readListing, type BrowserBrandScanner, type ScanReaders } from "@crawl-automation/app";
import { createListingPages } from "@crawl-automation/channels-core";
import { BrandListingRequestSchema } from "@crawl-automation/workflows";
import type { WorkerParts } from "../container.js";
import { requireRoleSection } from "../processes/role-settings.js";
import { guarded } from "./activity-guard.js";
import { measuredListingRequest } from "./activity-provider-context.js";

/** Full listing read inside one gated, non-retrying Activity; source capabilities choose the transport. */
export function brandListingActivities(parts: WorkerParts) {
  let pages: ScanReaders["pages"] | undefined;
  const readBrandListing = async (raw: unknown, signal: AbortSignal) => {
    const scan = BrandListingRequestSchema.parse(raw);
    const { channel, url } = scan.source;
    const adapter = parts.registry.forBrandSource(channel, url);
    const brandScan = adapter.brandScan;
    const browser: BrowserBrandScanner | undefined = brandScan
      ? {
          sourceUrl: (sourceUrl) => brandScan.sourceUrl(sourceUrl),
          scan: (request, signal) => parts.browser.scanner.scan(request, signal),
        }
      : undefined;
    const readers: ScanReaders = {
      registry: parts.registry,
      channels: parts.config.brandScans?.channels ?? {},
      pages: {
        read: (request, signal) => {
          pages ??= createListingPages(
            requireRoleSection(parts.config, "brandScans", "pipeline"),
            parts.r2.store,
          );
          return measuredListingRequest(pages, request, signal);
        },
      },
      browsers: browser ? { [channel]: browser } : {},
    };
    return readListing(readers, scan, signal);
  };
  return { readBrandListing: guarded("readBrandListing", readBrandListing, parts.log) };
}
