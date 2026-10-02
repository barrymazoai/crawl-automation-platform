import { PostgresBrandScans } from "@crawl-automation/adapters";
import { checkScanCancellation } from "@crawl-automation/app";
import { readListing, type BrowserBrandScanner, type ScanReaders } from "@crawl-automation/app";
import { createListingPages } from "@crawl-automation/channels-core";
import { BrandListingRequestSchema } from "@crawl-automation/workflows";
import type { WorkerParts } from "../container.js";
import { requireRoleSection } from "../processes/role-settings.js";
import { guarded } from "./activity-guard.js";
import { measuredListingRequest } from "./activity-provider-context.js";
import { checkBrowserPermit } from "./browser-permit.js";

/** Full listing read inside one gated, non-retrying Activity; source capabilities choose the transport. */
export function brandListingActivities(parts: WorkerParts) {
  let pages: ScanReaders["pages"] | undefined;
  const readBrandListing = async (raw: unknown, signal: AbortSignal) => {
    const scan = BrandListingRequestSchema.parse(raw);
    const { channel, url } = scan.source;
    const adapter = parts.registry.forBrandSource(channel, url);
    const browser =
      adapter.scanCapture?.(url) === "browser"
        ? listingBrowser(parts, adapter.brandScan)
        : undefined;
    const readers: ScanReaders = {
      registry: parts.registry,
      checkpoint: (scanId) => checkScanCancellation(new PostgresBrandScans(parts.database), scanId),
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
  return {
    readBrandListing: guarded(
      "readBrandListing",
      {
        run: readBrandListing,
        beforePermit: (raw) => checkListingBrowserPermit(parts, raw),
      },
      parts.log,
    ),
  };
}

async function checkListingBrowserPermit(parts: WorkerParts, raw: unknown): Promise<void> {
  const { source } = BrandListingRequestSchema.parse(raw);
  const adapter = parts.registry.forBrandSource(source.channel, source.url);
  if (adapter.scanCapture?.(source.url) === "browser") {
    await checkBrowserPermit(parts);
  }
}

function listingBrowser(
  parts: WorkerParts,
  brandScan: { sourceUrl(url: string): string } | undefined,
): BrowserBrandScanner {
  return {
    // Browser-only adapters validate the source in forBrandSource / scanCapture and in their scanner.
    sourceUrl: (url) => brandScan?.sourceUrl(url) ?? url,
    scan: (request, signal) =>
      parts.browser.scanner.scan(
        {
          ...request,
          checkpoint: () =>
            checkScanCancellation(new PostgresBrandScans(parts.database), request.scanId),
        },
        signal,
      ),
  };
}
