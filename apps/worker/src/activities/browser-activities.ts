import { PostgresBrandScans } from "@crawl-automation/adapters";
import { checkScanCancellation } from "@crawl-automation/app";
import { BrowserScanInputSchema, ProductPipelineInputSchema } from "@crawl-automation/workflows";
import type { WorkerParts } from "../container.js";
import { guarded } from "./activity-guard.js";

/**
 * The browser worker's activities (it runs on each Mac mini that has Ego): a browser-captured product page for the
 * pipeline, and brand listings for DTC, Amazon Store and Whole Foods. Only Whole Foods pages need
 * store preparation; DTC reads use the configured Ego browser.
 */
export function browserActivities(parts: WorkerParts) {
  const handlers = {
    captureBrowserProduct: async (raw: unknown, signal: AbortSignal) => {
      const input = ProductPipelineInputSchema.parse(raw);
      await parts.browser.ensureStore(input.url, signal);
      return parts.browser.capture.capture(input, signal);
    },
    scanBrandInBrowser: async (raw: unknown, signal: AbortSignal) => {
      const {
        channel: _channel,
        capture: _capture,
        ...request
      } = BrowserScanInputSchema.parse(raw);
      const checkpoint = () =>
        checkScanCancellation(new PostgresBrandScans(parts.database), request.scanId);
      await checkpoint();
      const { sourceUrl } = request;
      await parts.browser.ensureStore(sourceUrl, signal);
      return parts.browser.scanner.scan({ ...request, checkpoint }, signal);
    },
  };
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [name, guarded(name, handler, parts.log)]),
  );
}
