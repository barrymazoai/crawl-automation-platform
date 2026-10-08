import { resolve } from "node:path";
import { PostgresSiteAnalyses } from "@crawl-automation/adapters";
import { SiteAnalysisRunner } from "@crawl-automation/app";
import {
  analyzeWithDtcAgent,
  DtcCaptureAgent,
  DtcAgentBrandScan,
  DtcAgentProductCapture,
  dtcAgentErrors,
  type DtcSitePolicy,
} from "@crawl-automation/channel-dtc";
import type { ProductSourcePlans } from "@crawl-automation/channels-core";
import type { EgoPages } from "@crawl-automation/platform";
import type { CoreParts } from "../core-parts.js";
import { dtcProductScope } from "./dtc-product-scope.js";
import { verifyDtcModelPermit } from "./dtc-model.js";
import { dtcSiteCheck } from "./dtc-site-check.js";

/** The same capture agent drives analysis, catalog discovery and per-product harvest. */
export function dtcAgentParts(
  parts: CoreParts,
  sites: readonly DtcSitePolicy[],
  inputs: { sourcePlans: ProductSourcePlans; pages: Pick<EgoPages, "round"> },
) {
  const { sourcePlans, pages } = inputs;
  const browser = parts.config.browser;
  const capture = captureAgent(parts);
  const siteCheck = dtcSiteCheck(parts, pages);
  return {
    product: new DtcAgentProductCapture({
      agent: capture,
      sites,
      publication: parts.publication,
      sourcePlans,
      productScope: dtcProductScope(parts),
      routeId: browser?.routeId ?? "ego-browser",
      egressId: browser?.egressId ?? "ego-browser/1",
    }),
    scanner: new DtcAgentBrandScan({ agent: capture, sites }),
    analysis: new SiteAnalysisRunner({
      store: new PostgresSiteAnalyses(parts.database),
      analyze: async (input, progress, signal) => {
        const skipped = await siteCheck(input, progress, signal);
        if (skipped) {
          return skipped;
        }
        const result = await analyzeWithDtcAgent(capture, input, signal);
        for (const key of result.archiveKeys) {
          await progress(key);
        }
        return result;
      },
    }),
  };
}

function captureAgent(parts: CoreParts) {
  const browser = parts.config.browser;
  const configured = browser?.dtcAgent;
  const agent =
    configured && browser
      ? new DtcCaptureAgent({
          settings: configured,
          ego: browser.ego,
          publication: parts.publication,
          skillRoot: resolve("crawl-products"),
          environment: process.env,
        })
      : null;
  return {
    acceptCatalogMethod: async (
      saved: Parameters<DtcCaptureAgent["acceptCatalogMethod"]>[0],
      sourceUrl: string,
    ) => {
      if (!agent) {
        throw dtcAgentErrors.create("DTC.AGENT_REQUIRED");
      }
      await agent.acceptCatalogMethod(saved, sourceUrl);
    },
    capture: async (request: Parameters<DtcCaptureAgent["capture"]>[0], signal: AbortSignal) => {
      if (!agent) {
        throw dtcAgentErrors.create("DTC.AGENT_REQUIRED");
      }
      await verifyDtcModelPermit(parts);
      return agent.capture(request, signal);
    },
  };
}
