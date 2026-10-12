import { describe, expect, it, vi } from "vitest";
import type { ListingObservation } from "../listings/listing-model.js";
import { missingEvidence } from "../listings/unlisted-evidence.js";
import { PipelineCapture } from "./pipeline-capture.js";
import { removedVariantSightings, type KnownVariants } from "./removed-variants.js";

const request = {
  runId: "7b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11",
  channel: "costco" as const,
  url: "https://www.costco.com/p/-/item/100018793",
  brandId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  sourceId: "1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  operationId: "pipeline-1",
};
const page = {
  channel: "costco" as const,
  url: request.url,
  listingId: "100018793",
  variantId: "382521",
  externalId: "100018793",
  capturedAt: "2026-10-12T12:00:00.000Z",
  commerce: null,
  archive: { objectKey: "v3/costco-html/pipeline-1/original.html", sha256: "a".repeat(64) },
};
const sibling = (variantId: string) => ({
  url: `${page.url}?v=${variantId}`,
  listingId: page.listingId,
  variantId,
});

function variants(
  known: string[],
  lists = true,
): KnownVariants & { known: ReturnType<typeof vi.fn> } {
  return { listsVariants: () => lists, known: vi.fn(async () => known) };
}

describe("removedVariantSightings", () => {
  it("records a variant offered before and missing from the live page, with the page as evidence", async () => {
    const sightings = await removedVariantSightings(
      variants(["382521", "1155942", "1792684"]),
      request,
      {
        page,
        discovered: [sibling("1155942")],
      },
    );
    expect(sightings).toEqual([
      expect.objectContaining({
        channel: "costco",
        listingId: "100018793",
        variantId: "1792684",
        state: "unlisted",
        reason: "variant_removed",
        capturedAt: page.capturedAt,
        evidence: expect.objectContaining({
          causeCode: "LISTING.VARIANT_REMOVED",
          finalUrl: page.url,
          artifactKey: page.archive.objectKey,
        }),
      }),
    ]);
    expect(sightings.map(missingEvidence)).toEqual([[]]);
  });

  it("counts variant member pages as offered", async () => {
    const offered = { page, variantPages: [{ page: { ...page, variantId: "1792684" } }] };
    expect(
      await removedVariantSightings(variants(["382521", "1792684"]), request, offered),
    ).toEqual([]);
  });

  it("judges nothing for a channel whose page does not list variants, a page listing none, or a cut-short list", async () => {
    const none = variants(["382521"]);
    expect(await removedVariantSightings(variants(["1"], false), request, { page })).toEqual([]);
    expect(
      await removedVariantSightings(none, request, { page: { ...page, variantId: null } }),
    ).toEqual([]);
    expect(none.known).not.toHaveBeenCalled();
    const full = Array.from({ length: 200 }, (_, index) => sibling(String(index)));
    expect(
      await removedVariantSightings(variants(["382521", "gone"]), request, {
        page,
        discovered: full,
      }),
    ).toEqual([]);
  });
});

it("PipelineCapture records removed variants after the live page and never fails the capture for them", async () => {
  const recorded: unknown[] = [];
  const listings = {
    record: vi.fn(async (raw: unknown) => {
      recorded.push(raw);
      return { observationId: "b".repeat(64) } as ListingObservation;
    }),
  };
  const discovered = [sibling("1155942")];
  const capture = { capture: async () => ({ status: "captured" as const, page, discovered }) };
  const pipeline = new PipelineCapture({
    capture,
    listings,
    variants: variants(["382521", "1155942", "gone"]),
  });
  expect(await pipeline.capture(request, AbortSignal.timeout(5_000))).toEqual({
    status: "captured",
    discovered,
  });
  expect(recorded.map((raw) => (raw as { state: string; variantId: string }).state)).toEqual([
    "live",
    "unlisted",
  ]);
  const failing = new PipelineCapture({
    capture,
    listings,
    variants: {
      listsVariants: () => true,
      known: async () => Promise.reject(new Error("db down")),
    },
  });
  await expect(failing.capture(request, AbortSignal.timeout(5_000))).resolves.toMatchObject({
    status: "captured",
  });
});
