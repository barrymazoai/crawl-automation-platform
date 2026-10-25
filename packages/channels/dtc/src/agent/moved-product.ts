import {
  movedSighting,
  type BrowserCaptureResult,
  type CaptureRequest,
  type OriginalHtmlArchive,
} from "@crawl-automation/channels-core";
import { createDtcAdapter } from "../adapter.js";
import type { DtcSitePolicy } from "../site-policy.js";
import type { MovedOriginal } from "./moved-original.js";
import { dtcAgentErrors } from "./errors.js";

/** Archive a moved DTC agent page under the requested task before recording its sighting. */
export async function movedProductSighting(input: {
  request: CaptureRequest;
  archive: OriginalHtmlArchive;
  moved: MovedOriginal;
  sites: readonly DtcSitePolicy[];
  routeId: string;
  egressId: string;
  signal: AbortSignal;
}): Promise<Extract<BrowserCaptureResult, { status: "sighted" }>> {
  const { request, archive, moved, sites, routeId, egressId, signal } = input;
  const original = await archive.save(
    moved.html,
    {
      mode: "browser",
      provider: "codex-ego-native/1",
      routeId,
      egressId,
      finalUrl: moved.actualUrl,
    },
    signal,
  );
  const adapter = createDtcAdapter(sites, request.sourceUrl);
  const requested = adapter.productAddress(request.url);
  const sighting = movedSighting(adapter, requested, {
    finalUrl: moved.actualUrl,
    archiveKey: original.source.objectKey,
  });
  if (!sighting) {
    throw dtcAgentErrors.create("DTC.CAPTURE_REVIEW");
  }
  const movedTo = queuedAddress(adapter, sighting, moved.actualUrl);
  return {
    status: "sighted",
    listingId: requested.listingId,
    variantId: requested.variantId,
    sighting,
    ...(movedTo ? { movedTo } : {}),
  };
}

/** Owner 2026-10-25: queue a moved product only at a distinct valid product address. */
function queuedAddress(
  adapter: ReturnType<typeof createDtcAdapter>,
  sighting: NonNullable<ReturnType<typeof movedSighting>>,
  actualUrl: string,
) {
  if (sighting.reason !== "redirected_to_other_product") {
    return null;
  }
  const address = adapter.productAddress(actualUrl);
  return { url: address.url, listingId: address.listingId, variantId: null };
}
