import { verifyBrowserStop } from "../browser/verify-browser-stop.js";
import { contextualActivity } from "./activity-context-handler.js";
import { SiteAnalysisSchema } from "@crawl-automation/v3-contracts";
import { PostgresBrandScans } from "@crawl-automation/adapters";
import { checkScanCancellation } from "@crawl-automation/app";
import { BrowserScanInputSchema, ProductPipelineInputSchema } from "@crawl-automation/workflows";
import type { WorkerParts } from "../container.js";
import { guarded } from "./activity-guard.js";
import { checkBrowserPermit } from "./browser-permit.js";

/**
 * The browser worker's activities (it runs on each Mac mini that has Ego): a browser-captured product page for the
 * pipeline, and brand listings for DTC, Amazon Store and Whole Foods. Only Whole Foods pages need
 * store preparation; DTC reads use the configured Ego browser.
 */
export function browserActivities(parts: WorkerParts) {
  const handlers = {
    analyzeSiteInBrowser: (raw: unknown, signal: AbortSignal) =>
      parts.browser.analysis.run(SiteAnalysisSchema.parse(raw), signal),
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
      return parts.browser.scanner.scan({ ...request, checkpoint }, signal);
    },
  };
  const activities = Object.fromEntries(
    Object.entries(handlers).map(([name, run]) => [
      name,
      guarded(
        name,
        {
          run,
          beforePermit: () => checkBrowserPermit(parts),
        },
        parts.log,
      ),
    ]),
  );
  return Object.assign(activities, { verifyBrowserStop: browserStopActivity(parts) });
}

function browserStopActivity(parts: WorkerParts) {
  return contextualActivity("verifyBrowserStop", (raw) => verifyBrowserStop(parts, raw), parts.log);
}
