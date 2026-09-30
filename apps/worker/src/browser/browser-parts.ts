import {
  configuredDtcSites,
  createDtcAdapter,
  DTC_BROWSER_POLICY,
} from "@crawl-automation/channel-dtc";
import { PipelineCapture } from "@crawl-automation/app";
import {
  BrowserPages,
  BrowserProductCapture,
  ChannelRegistry,
  HttpCapture,
  ProductSourcePlans,
  type BrowserCaptureResult,
} from "@crawl-automation/channels-core";
import {
  wholeFoodsAdapter,
  wholeFoodsBrowserPolicy,
  type WholeFoodsStore,
} from "@crawl-automation/channels-wholefoods";
import { EgoPages } from "@crawl-automation/platform";
import { captureRecords } from "../capture-records.js";
import type { CoreParts } from "../core-parts.js";
import { workerErrors } from "../errors.js";
import type { BrowserScanners } from "./browser-scanners.js";
import { ManagedBrowserRounds, egoTargetVerifier } from "./managed-rounds.js";
import { buildBrowserScanners } from "./scan-wiring.js";
import { StoreEgoRounds } from "./store-rounds.js";

/** Product capture plus capability-selected brand scans on either browser worker. */
export interface BrowserParts {
  capture: PipelineCapture<BrowserCaptureResult>;
  scanner: BrowserScanners;
  /** Sets the store in the browser profile once, before the first page this process reads. */
  ensureStore(productUrl: string, signal: AbortSignal): Promise<void>;
}

function browserSettings(parts: CoreParts) {
  const settings = parts.config.browser;
  if (!settings) {
    throw workerErrors.create("WORKER.PROCESSING_SETTINGS_MISSING", {
      details: { part: "browser" },
    });
  }
  return settings;
}

export function buildBrowserParts(parts: CoreParts): BrowserParts {
  const settings = browserSettings(parts);
  const dtcSites = configuredDtcSites(settings.dtc);
  const store: WholeFoodsStore = settings.wholefoods;
  const ego = new EgoPages(settings.ego);
  const pages = new BrowserPages(ego, {
    routeId: settings.routeId,
    egressId: settings.egressId,
    channels: { wholefoods: wholeFoodsBrowserPolicy(store), dtc: DTC_BROWSER_POLICY },
  });
  const registry = new ChannelRegistry([wholeFoodsAdapter(store), createDtcAdapter(dtcSites)]);
  const http = new HttpCapture(pages);
  const capture = new BrowserProductCapture({
    registry,
    http,
    publication: parts.publication,
    sourcePlans: new ProductSourcePlans(parts.publication, {
      ...parts.config.plan,
      egressId: parts.fileTransport.egressId,
    }),
  });
  const scanner = buildBrowserScanners({
    ego,
    store,
    dtcSites,
    publication: parts.publication,
    rounds: new ManagedBrowserRounds(
      new StoreEgoRounds({ settings: settings.ego, pages: ego }),
      egoTargetVerifier(settings.ego),
    ),
  });
  return {
    capture: new PipelineCapture<BrowserCaptureResult>({
      capture,
      ...captureRecords({ database: parts.database, log: parts.log, registry }),
    }),
    scanner,
    ensureStore: (url, signal) => scanner.prepare(url, signal),
  };
}
