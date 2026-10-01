import { measuredCall, sha256 } from "@crawl-automation/platform";
import type { PageFetcher } from "@crawl-automation/channels-core";
import type { ScanReaders } from "@crawl-automation/app";
import type { LabelPlans } from "@crawl-automation/processing";
import { activityIdentity } from "./activity-identity.js";

export function measuredPages(pages: PageFetcher): PageFetcher {
  return {
    mode: pages.mode,
    fetchPage: (request, signal) =>
      measuredCall(
        {
          kind: "capture",
          step: "fetchPage",
          channel: request.channel,
          providerCall: true,
          cacheHit: false,
        },
        () => pages.fetchPage(request, signal),
        (page) => ({
          creditCost: page.fetchedVia.creditCost ?? null,
          sourceHash: sha256(page.bytes),
        }),
      ),
  };
}

/** Per-request costs, including failed reads, separate from a scan's aggregate result. */
export function measuredListingRequest(
  reader: ScanReaders["pages"],
  request: Parameters<ScanReaders["pages"]["read"]>[0],
  signal: AbortSignal,
) {
  return measuredCall(
    {
      kind: "brand-request",
      step: "readListingPage",
      channel: request.channel,
      scanId: request.scanId,
      operationId: `${request.scanId}:${request.label}`,
    },
    () => reader.read(request, signal),
    (page) => ({
      cacheHit: page.fromArchive,
      providerCall: !page.fromArchive,
      creditCost: page.fromArchive ? 0 : page.creditCost,
    }),
  );
}

/** Every source() invocation is currently a recomputation, including manifest's internal this.source calls. */
export function measuredLabelPlans(plans: LabelPlans): LabelPlans {
  const source = plans.source.bind(plans);
  plans.source = (raw, signal) => {
    const identity = activityIdentity(raw);
    return measuredCall(
      {
        kind: "preparation",
        step: "prepareLabelSource",
        cacheHit: false,
        operationId: identity.operationId,
        sourceId: sourceId(raw),
        sourceHash: identity.sourceHash,
      },
      () => source(raw, signal),
      (result) => ({ outcomeCode: result.status, sourceHash: activityIdentity(result).sourceHash }),
    );
  };
  return plans;
}

function sourceId(raw: unknown): string | null {
  if (raw && typeof raw === "object" && "sourceId" in raw && typeof raw.sourceId === "string") {
    return raw.sourceId;
  }
  return null;
}
