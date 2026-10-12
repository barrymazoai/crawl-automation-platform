import { listingErrors } from "@crawl-automation/platform";
import {
  MAX_DISCOVERED,
  type CapturedPage,
  type CaptureRequest,
  type DiscoveredVariant,
} from "@crawl-automation/channels-core";
import type { ListingSightingInput } from "../listings/listing-model.js";
import { productRunSource } from "./live-sighting.js";

/** Variants this channel's shared pages offered before (owner 2026-10-12: a variant gone from a live page). */
export interface KnownVariants {
  /** True when the channel's page lists every variant it offers (adapter `discoversVariants`). */
  listsVariants(channel: string): boolean;
  /** The variant IDs ever queued for this listing on this channel. */
  known(channel: string, listingId: string): Promise<string[]>;
}

/** What one capture shows of its page's variants: the captured one, the discovered ones and variant member pages. */
export interface OfferedVariants {
  page: CapturedPage;
  discovered?: DiscoveredVariant[] | undefined;
  variantPages?: { page: CapturedPage }[] | undefined;
}

/**
 * Unlisted sightings (`variant_removed`) for variants this listing offered before and its live page no longer lists.
 * Nothing is judged when the page lists no variant or its list may be cut short: absence must be read, never assumed.
 */
export async function removedVariantSightings(
  variants: KnownVariants,
  request: CaptureRequest,
  offered: OfferedVariants,
): Promise<ListingSightingInput[]> {
  const { page, discovered = [] } = offered;
  if (!variants.listsVariants(page.channel) || discovered.length >= MAX_DISCOVERED) {
    return [];
  }
  const listed = listedVariants(offered);
  if (listed.size === 0) {
    return [];
  }
  const known = await variants.known(page.channel, page.listingId);
  return known
    .filter((variantId) => !listed.has(variantId))
    .map((variantId) => removedSighting(request, page, variantId));
}

function listedVariants({ page, discovered = [], variantPages = [] }: OfferedVariants) {
  return new Set(
    [
      page.variantId,
      ...discovered
        .filter((variant) => variant.listingId === page.listingId)
        .map((variant) => variant.variantId),
      ...variantPages.map((member) => member.page.variantId),
    ].filter((variantId): variantId is string => variantId !== null),
  );
}

function removedSighting(
  request: CaptureRequest,
  page: CapturedPage,
  variantId: string,
): ListingSightingInput {
  return {
    channel: page.channel,
    listingId: page.listingId,
    variantId,
    brandId: request.brandId,
    runId: request.runId,
    state: "unlisted",
    reason: "variant_removed",
    evidence: {
      probe: "direct-revisit",
      causeCode: listingErrors.code("LISTING.VARIANT_REMOVED"),
      httpStatus: null,
      observedExternalId: null,
      finalUrl: page.url,
      artifactKey: page.archive.objectKey,
    },
    source: productRunSource(request),
    capturedAt: page.capturedAt,
  };
}
