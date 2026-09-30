import { BrowserScanInputSchema, ProductPipelineInputSchema } from "@crawl-automation/workflows";
import type { WorkerParts } from "../container.js";
import { guarded } from "./activity-guard.js";

/**
 * The browser worker's activities (it runs on each Mac mini that has Ego): a browser-captured product page for the
 * pipeline, and a brand listing scanned in the browser for the API's brand scan (Whole Foods today; DTC and Amazon
 * Store-page brands next). The Whole Foods store is set before the first page.
 */
export function browserActivities(parts: WorkerParts) {
  const handlers = {
    captureBrowserProduct: async (raw: unknown, signal: AbortSignal) => {
      const input = ProductPipelineInputSchema.parse(raw);
      await parts.browser.ensureStore(input.url, signal);
      return parts.browser.capture.capture(input, signal);
    },
    scanBrandInBrowser: async (raw: unknown, signal: AbortSignal) => {
      const { scanId, sourceUrl } = BrowserScanInputSchema.parse(raw);
      await parts.browser.ensureStore(sourceUrl, signal);
      return parts.browser.scanner.scan({ scanId, sourceUrl }, signal);
    },
  };
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [name, guarded(name, handler, parts.log)]),
  );
}
