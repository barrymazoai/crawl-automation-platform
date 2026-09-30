import type { ChannelRegistry } from "@crawl-automation/channels-core";
import { appErrors } from "../errors.js";
import type { BrowserBrandScanners } from "./ports.js";
import { type ScanChannel } from "./scan-model.js";

/**
 * Refuses a channel that cannot be read here at all, before any brand is read: no adapter brand reader and no
 * per-source capture choice, or a browser channel without a configured scanner. Which reader a given source URL
 * uses is still chosen per source (Amazon search pages over HTTP, Store pages in the browser).
 */
export function assertScanReadable(
  readers: { registry: ChannelRegistry; browsers: BrowserBrandScanners },
  channel: ScanChannel,
): void {
  const adapter = readers.registry.channels().includes(channel)
    ? readers.registry.get(channel)
    : undefined;
  if (adapter?.brandScan || adapter?.scanCapture) {
    return;
  }
  if (!readers.browsers[channel]) {
    throw appErrors.create("BRAND_SCAN.CHANNEL_UNSUPPORTED", { details: { channel } });
  }
}
