import { PostgresSiteAnalyses } from "@crawl-automation/adapters";
import { siteAnalysisRunner } from "./site-analysis-parts.js";
import {
  configuredDtcSites,
  storedDtcSites,
  DTC_BROWSER_POLICY,
} from "@crawl-automation/channel-dtc";
import { PipelineCapture } from "@crawl-automation/app";
import {
  BrowserPages,
  BrowserProductCapture,
  HttpCapture,
  ProductSourcePlans,
  type BrowserCaptureResult,
} from "@crawl-automation/channels-core";
import { EgoPages } from "@crawl-automation/platform";
import { captureRecords } from "../capture-records.js";
import type { CoreParts } from "../core-parts.js";
import { workerErrors } from "../errors.js";
import { requireRoleSection } from "../processes/role-settings.js";
import type { BrowserScanners } from "./browser-scanners.js";
import { buildBrowserScanners } from "./scan-wiring.js";

/** Product capture plus capability-selected brand scans on either browser worker. */
export interface BrowserParts {
  capture: PipelineCapture<BrowserCaptureResult>;
  scanner: BrowserScanners;
  analysis: ReturnType<typeof siteAnalysisRunner>;
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

function scanSettings(settings: ReturnType<typeof browserSettings>) {
  return {
    store: settings.wholefoods,
    wholefoodsScan: settings.wholefoodsScan,
    costcoStore: settings.costco,
    costcoScan: settings.costcoScan,
  };
}

export function buildBrowserParts(parts: CoreParts): BrowserParts {
  const settings = browserSettings(parts);
  const dtcSites = configuredDtcSites(settings.dtc);
  const ego = new EgoPages(settings.ego);
  const pages = new BrowserPages(ego, {
    routeId: settings.routeId,
    egressId: settings.egressId,
    channels: { dtc: DTC_BROWSER_POLICY },
  });
  const registry = parts.registry;
  const capture = new BrowserProductCapture({
    registry,
    http: new HttpCapture(pages),
    publication: parts.publication,
    sourcePlans: new ProductSourcePlans(parts.publication, {
      ...requireRoleSection(parts.config, "plan", "browser"),
      egressId: parts.fileTransport.egressId,
    }),
  });
  const scanner = buildBrowserScanners({
    ego,
    dtcSites,
    ...scanSettings(settings),
    publication: parts.publication,
    rounds: ego,
    beforeRead: refreshStoredSites({ parts, settings, dtcSites }),
  });
  return {
    capture: new PipelineCapture<BrowserCaptureResult>({
      capture,
      ...captureRecords({ database: parts.database, log: parts.log, registry }),
    }),
    scanner,
    analysis: siteAnalysisRunner(parts, ego),
    ensureStore: (url, signal) => scanner.prepare(url, signal),
  };
}

function refreshStoredSites(input: {
  parts: CoreParts;
  settings: ReturnType<typeof browserSettings>;
  dtcSites: ReturnType<typeof configuredDtcSites>;
}) {
  return async () => {
    const stored = await new PostgresSiteAnalyses(input.parts.database).settings();
    const sites = storedDtcSites(configuredDtcSites(input.settings.dtc), stored);
    input.dtcSites.splice(0, input.dtcSites.length, ...sites);
  };
}
