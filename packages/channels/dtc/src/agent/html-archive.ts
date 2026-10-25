import { OriginalHtmlArchive, type CaptureRequest } from "@crawl-automation/channels-core";
import type { RetainedPublication } from "@crawl-automation/platform";
import { createDtcAdapter } from "../adapter.js";
import type { DtcSitePolicy } from "../site-policy.js";
import type { readCapturedProduct } from "./product-record.js";

export function agentHtmlArchive(
  deps: { publication: RetainedPublication; sites: readonly DtcSitePolicy[] },
  request: CaptureRequest,
) {
  const { publication, sites } = deps;
  const adapter = createDtcAdapter(sites, request.sourceUrl);
  const address = adapter.productAddress(request.url);
  return new OriginalHtmlArchive(publication, {
    channel: "dtc",
    maxBytes: adapter.httpPolicy.maxBytes,
    capture: {
      operationId: request.operationId,
      sessionId: request.operationId,
      sourceId: request.sourceId,
      ...address,
    },
  });
}

export function saveAgentOriginal(input: {
  archive: OriginalHtmlArchive;
  retained: Awaited<ReturnType<typeof readCapturedProduct>>;
  routeId: string;
  egressId: string;
  signal: AbortSignal;
}) {
  const { archive, retained, routeId, egressId, signal } = input;
  return archive.save(
    retained.html,
    {
      mode: "browser",
      provider: "codex-ego-native/1",
      routeId,
      egressId,
      finalUrl: retained.record.productUrl,
    },
    signal,
  );
}
