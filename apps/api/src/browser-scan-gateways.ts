import type { TemporalBrowserScans } from "@crawl-automation/adapters";
import type { BrowserBrandScanners, ScanChannel } from "@crawl-automation/app";
import { brandScanErrors, type ChannelRegistry } from "@crawl-automation/channels-core";

/** Every registered reader with a browser scan capability gets the same Temporal gateway. */
export function adapterBrowserScanners(registry: ChannelRegistry, scans: TemporalBrowserScans) {
  const gateways: BrowserBrandScanners = {};
  for (const channel of registry.channels()) {
    const adapter = registry.get(channel);
    if (!adapter.brandScan || !adapter.scanCapture) {
      continue;
    }
    gateways[channel as ScanChannel] = {
      sourceUrl: (url) => {
        const selected = registry.forBrandSource(channel, url);
        if (selected.scanCapture?.(url) !== "browser" || !selected.brandScan) {
          throw brandScanErrors.create("BRAND_SCAN.URL");
        }
        return selected.brandScan.sourceUrl(url);
      },
      scan: (request, signal) => scans.scan({ channel, ...request }, signal),
    };
  }
  return gateways;
}
