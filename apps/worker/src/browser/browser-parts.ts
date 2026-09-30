import { PipelineCapture } from "@crawl-automation/app";
import {
  BrowserPages,
  BrowserProductCapture,
  ChannelRegistry,
  HttpCapture,
  type BrowserCaptureResult,
} from "@crawl-automation/channels-core";
import {
  WholeFoodsBrandScan,
  ensureWholeFoodsStore,
  wholeFoodsAdapter,
  wholeFoodsBrowserPolicy,
  type WholeFoodsStore,
} from "@crawl-automation/channels-wholefoods";
import { EgoPages } from "@crawl-automation/platform";
import { captureRecords } from "../capture-records.js";
import type { CoreParts } from "../core-parts.js";
import { workerErrors } from "../errors.js";

const STORE_SETUP_TIMEOUT_MS = 120_000;

/** Whole Foods capture and brand scans in the Ego browser, with the store set once per process. */
export interface BrowserParts {
  capture: PipelineCapture<BrowserCaptureResult>;
  scanner: WholeFoodsBrandScan;
  /** Sets the store in the browser profile once, before the first page this process reads. */
  ensureStore(productUrl: string, signal: AbortSignal): Promise<void>;
}

export function buildBrowserParts(parts: CoreParts): BrowserParts {
  const settings = parts.config.browser;
  if (!settings) {
    throw workerErrors.create("WORKER.PROCESSING_SETTINGS_MISSING", {
      details: { part: "browser" },
    });
  }
  const store: WholeFoodsStore = settings.wholefoods;
  const ego = new EgoPages(settings.ego);
  const pages = new BrowserPages(ego, {
    routeId: settings.routeId,
    egressId: settings.egressId,
    channels: { wholefoods: wholeFoodsBrowserPolicy(store) },
  });
  const registry = new ChannelRegistry([wholeFoodsAdapter(store)]);
  const http = new HttpCapture(pages);
  const capture = new BrowserProductCapture({ registry, http, publication: parts.publication });
  let storeSet: Promise<unknown> | null = null;
  return {
    capture: new PipelineCapture<BrowserCaptureResult>({
      capture,
      ...captureRecords({ database: parts.database, log: parts.log, registry }),
    }),
    scanner: new WholeFoodsBrandScan({ browser: ego, remote: parts.r2.store, store }),
    async ensureStore(productUrl, signal) {
      storeSet ??= ensureWholeFoodsStore(
        ego,
        { store, productUrl, timeoutMs: STORE_SETUP_TIMEOUT_MS },
        signal,
      );
      try {
        await storeSet;
      } catch (error) {
        // A failed setup is tried again by the next page, never silently skipped.
        storeSet = null;
        throw error;
      }
    },
  };
}
