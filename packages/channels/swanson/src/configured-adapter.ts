import { swansonAdapter } from "./adapter.js";
import { createSwansonBrandScan } from "./brand-scan.js";
import type { SwansonBrandScanSettings } from "./brand-scan-settings.js";

/** Product capture stays unchanged; only the listing reader receives storefront settings. */
export function createSwansonAdapter(settings?: SwansonBrandScanSettings) {
  return { ...swansonAdapter, brandScan: createSwansonBrandScan(settings) };
}
