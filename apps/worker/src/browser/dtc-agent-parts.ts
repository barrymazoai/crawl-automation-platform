import { resolve } from "node:path";
import { PostgresSiteAnalyses, PostgresResourceStore } from "@crawl-automation/adapters";
import { currentPermitExecution } from "@crawl-automation/platform";
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
import type { CoreParts } from "../core-parts.js";

/** The same capture agent drives analysis, catalog discovery and per-product harvest. */
export function dtcAgentParts(
  parts: CoreParts,
  sites: readonly DtcSitePolicy[],
  sourcePlans: ProductSourcePlans,
) {
  const browser = parts.config.browser;
  const capture = captureAgent(parts);
  return {
    product: new DtcAgentProductCapture({
      agent: capture,
      sites,
      publication: parts.publication,
      sourcePlans,
      routeId: browser?.routeId ?? "ego-browser",
      egressId: browser?.egressId ?? "ego-browser/1",
    }),
    scanner: new DtcAgentBrandScan({ agent: capture, sites }),
    analysis: new SiteAnalysisRunner({
      store: new PostgresSiteAnalyses(parts.database),
      analyze: async (input, progress, signal) => {
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
    capture: async (request: Parameters<DtcCaptureAgent["capture"]>[0], signal: AbortSignal) => {
      if (!agent) {
        throw dtcAgentErrors.create("DTC.AGENT_REQUIRED");
      }
      await verifyCaptureModelPermit(parts);
      return agent.capture(request, signal);
    },
  };
}

async function verifyCaptureModelPermit(parts: CoreParts): Promise<void> {
  const owner = currentPermitExecution();
  const resource = parts.config.browser?.dtcAgent?.modelResourceId;
  const held = owner
    ? await new PostgresResourceStore(parts.database).findHeld(owner.permitId)
    : null;
  if (
    !owner ||
    !resource ||
    !held?.resources.includes(resource) ||
    held.workflowId !== owner.workflowId ||
    held.runId !== owner.runId
  ) {
    throw dtcAgentErrors.create("DTC.AGENT_REQUIRED", {
      details: { reason: "capture_model_permit_required" },
    });
  }
}
